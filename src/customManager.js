const { ComponentType, ChannelType, MessageFlags } = require('discord.js');
const Config = require('../models/Config');
const { applyMatchResult } = require('./playerManager');
const {
	createTextChannel,
	createVoiceChannel,
	moveUserToChannel,
	createCategory,
	moveCategoryToBottom,
	wait,
} = require('./discordUtils');
const {
	clearPreviousMessage,
	generateQueue,
	createButtons,
	createRoleButtons,
	collectWinnerVoteFromTeams,
	buildPointsUpdateEmbed,
} = require('./messages');
const { draftStart } = require('./draftManager');

/* --------------------------------------------
 * Small helpers
 * ------------------------------------------ */

const safeDelete = async (x) => {
	try { if (x?.deletable !== false) await x?.delete?.(); } catch (_) {}
};
const fetchMember = async (guild, userId) => {
	return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
};
const maybeNumber = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);

/* --------------------------------------------
 * Ephemeral helpers (auto-delete via webhook)
 * ------------------------------------------ */

// Always create an EPHEMERAL FOLLOW-UP when possible and delete by id via webhook.
// Never use deleteReply() here (can nuke the source message when deferred).
async function sendEphemeral(i, payload, ttlMs) {
	const opts = { ...payload, flags: MessageFlags.Ephemeral, fetchReply: true };
	let msg = null;
	try {
		// Prefer followUp so lifecycle is decoupled from the original message
		msg = await i.followUp(opts);
	} catch {
		// If followUp fails (no initial response yet), reply once as fallback
		try { msg = await i.reply(opts); } catch { return null; }
	}
	if (ttlMs && msg?.id) {
		setTimeout(() => {
			i.webhook?.deleteMessage?.(msg.id).catch(() => {});
		}, ttlMs);
	}
	return msg;
}

// For nested interactions (like roleInteraction), also delete only by id via webhook.
async function replyEphemeral(interaction, payload, ttlMs) {
	let msg = null;
	try {
		msg = await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral, fetchReply: true });
	} catch {
		try { msg = await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral, fetchReply: true }); }
		catch { return null; }
	}
	if (ttlMs && msg?.id) {
		setTimeout(() => {
			interaction.webhook?.deleteMessage?.(msg.id).catch(() => {});
		}, ttlMs);
	}
	return msg;
}

function deleteEphemeralBy(webhookOwnerInteraction, msg, delayMs = 0) {
	if (!msg?.id || !webhookOwnerInteraction?.webhook) return;
	setTimeout(() => {
		webhookOwnerInteraction.webhook.deleteMessage(msg.id).catch(() => {});
	}, delayMs);
}

async function bumpQueueMessage(channel, config, queue, queueNumber) {
	try {
		// Delete old message if still exists
		if (config.lastQueueMessageID) {
			const oldMsg = await channel.messages.fetch(config.lastQueueMessageID).catch(() => null);
			if (oldMsg) await oldMsg.delete().catch(() => {});
		}

		// Send new queue message at bottom
		const queueMessage = await channel.send({
			embeds: [generateQueue(queue, config)],
			components: [createButtons()],
		});

		// Save new ID
		config.lastQueueMessageID = queueMessage.id;
		await config.save();

		return queueMessage;
	} catch (err) {
		console.error("Failed to bump queue message:", err);
	}
}


/* --------------------------------------------
 * Simple per-key async mutex to serialize button handlers
 * ------------------------------------------ */
class Mutex {
	constructor() { this._q = Promise.resolve(); }
	run(fn) {
		const p = this._q.then(fn, fn);
		this._q = p.then(() => {}, () => {});
		return p;
	}
}
const locks = new Map();
const getLock = (key) => {
	if (!locks.has(key)) locks.set(key, new Mutex());
	return locks.get(key);
};

/* --------------------------------------------
 * In-memory per-guild/per-queue state
 * ------------------------------------------ */
const globalState = new Map();
function getGuildState(serverID) {
	if (!globalState.has(serverID)) {
		globalState.set(serverID, {
			queues: new Map(),
			channels: new Map(),
			matches: new Map(),
		});
	}
	return globalState.get(serverID);
}

function makeEmptyQueue() {
	return { Top: [], Jg: [], Mid: [], Adc: [], Supp: [] };
}

async function moveUsersToVoiceChannel(guild, voiceChannel, fromChannelId, group) {
	if (!voiceChannel) return;
	const jobs = [];
	for (const role of Object.keys(group)) {
		const raw = group?.[role];
		const ids = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? [raw.trim()] : []);
		for (const userId of ids) {
			const member = await fetchMember(guild, userId);
			if (member?.voice?.channel?.id === fromChannelId) {
				jobs.push(moveUserToChannel(member, voiceChannel));
			}
		}
	}
	await Promise.allSettled(jobs);
}

function isQueueFull(queue, perRoleCap = 2) {
	return Object.values(queue).every((arr) => arr.length >= perRoleCap);
}

function removeUserFromQueue(queue, userId) {
	for (const role of Object.keys(queue)) {
		const idx = queue[role].indexOf(userId);
		if (idx !== -1) {
			queue[role].splice(idx, 1);
			return true;
		}
	}
	return false;
}

async function writeCustomQueue(channel) {
	const serverID = channel.guild.id;
	const config = await Config.findOne({ serverID }) ?? new Config({ serverID });

	const perRoleCap = maybeNumber(config.PerRoleCapacity, 2);
	const voteThreshold = maybeNumber(config.VoteThreshold, 6);
	const voteTimeoutMs = maybeNumber(config.VoteTimeoutMs, 2 * 60 * 60 * 1000);
	const deleteShortMs = maybeNumber(config.DeleteShortMs, 2000);
	const deleteMediumMs = maybeNumber(config.DeleteMediumMs, 5000);
	const deleteLongMs = maybeNumber(config.DeleteLongMs, 10000);

	if (typeof config.QueueNumber !== 'number' || !Number.isFinite(config.QueueNumber)) {
		config.QueueNumber = 1;
	}
	const queueNumber = config.QueueNumber;

	const state = getGuildState(serverID);

	state.queues.set(queueNumber, makeEmptyQueue());
	state.channels.set(queueNumber, {});
	state.matches.set(queueNumber, {});

	const queue = state.queues.get(queueNumber);
	const queueChannels = state.channels.get(queueNumber);
	const matches = state.matches.get(queueNumber);

	await clearPreviousMessage(channel, config);

	const queueMessage = await bumpQueueMessage(channel, config, queue, queueNumber);

	await Config.findOneAndUpdate(
		{ serverID },
		{ lastQueueMessageID: queueMessage.id },
		{ upsert: true }
	);

	const collector = queueMessage.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: 0,
	});

	const lock = getLock(`${serverID}:${queueNumber}`);

	collector.on('collect', async (i) => {
		if (!['join_queue', 'leave_queue'].includes(i.customId)) return;
		const userId = i.user.id;

		// Ack in <3s to avoid "Interaction failed"
		if (!i.deferred && !i.replied) {
			await i.deferUpdate().catch(() => {});
		}

		await lock.run(async () => {
			let needsEdit = true;

			if (i.customId === 'join_queue') {
				if (Object.values(queue).flat().includes(userId)) {
					await sendEphemeral(i, { content: '❌ You are already in the queue!' }, deleteShortMs);
					return;
				}
				if (isQueueFull(queue, perRoleCap)) {
					await sendEphemeral(i, { content: '❌ The queue is already full!' }, deleteShortMs);
					return;
				}

				const rolePromptMsg = await sendEphemeral(
					i,
					{
						content: 'Choose your role:',
						components: [createRoleButtons(queue, perRoleCap)],
					},
					null
				);

				const roleInteraction = rolePromptMsg
					? await rolePromptMsg.awaitMessageComponent({
						componentType: ComponentType.Button,
						time: 30_000,
						filter: (btn) => btn.user.id === userId && btn.customId.startsWith('role_'),
					}).catch(() => null)
					: null;

				deleteEphemeralBy(i, rolePromptMsg, 0);

				if (!roleInteraction) {
					await sendEphemeral(i, { content: '⏰ You did not pick a role in time.' }, deleteShortMs);
					return;
				}

				const role = roleInteraction.customId.replace('role_', '');

				if (Object.values(queue).flat().includes(userId)) {
					await replyEphemeral(roleInteraction, { content: '❌ You are already in the queue!' }, deleteShortMs);
					needsEdit = false;
					return;
				}
				if (!queue[role]) {
					await replyEphemeral(roleInteraction, { content: `❌ Unknown role: ${role}` }, deleteShortMs);
					needsEdit = false;
					return;
				}
				if (queue[role].length >= perRoleCap) {
					await replyEphemeral(roleInteraction, { content: `❌ The ${role} role is full!` }, deleteShortMs);
					needsEdit = false;
					return;
				}

				queue[role].push(userId);
				await replyEphemeral(roleInteraction, { content: `✅ You joined as ${role}!` }, deleteShortMs);
			} else if (i.customId === 'leave_queue') {
				const removed = removeUserFromQueue(queue, userId);
				if (removed) {
					await sendEphemeral(i, { content: '✅ You left the queue!' }, deleteShortMs);
				} else {
					await sendEphemeral(i, { content: '❌ You are not in the queue!' }, deleteShortMs);
				}
			}

			if (needsEdit) {
				await queueMessage.edit({
					embeds: [generateQueue(queue, config)],
					components: [createButtons()],
				}).catch(() => {});
			}

			if (isQueueFull(queue, perRoleCap)) {
				collector.stop('Queue is full');
			}
		});
	});

	collector.on('end', async (_collected, reason) => {
		const cleanupAll = async (createdCategory) => {
			await wait(deleteLongMs);
			await safeDelete(queueChannels.text);
			if (createdCategory) await safeDelete(queueChannels.category);
			globalState.get(serverID)?.queues?.delete(queueNumber);
			globalState.get(serverID)?.channels?.delete(queueNumber);
			globalState.get(serverID)?.matches?.delete(queueNumber);
		};

		if (reason !== 'Queue is full') {
			return cleanupAll(false);
		}

		const mess = await channel.send({ content: 'The queue is now full! Starting the game...' }).catch(() => null);
		setTimeout(async () => { try { if (mess) await mess.delete(); } catch {} }, deleteMediumMs);

		let createdCategory = false;

		try {
			// Reuse the lobby VC's parent category if present; otherwise create a new one
			const lobbyVC = channel.guild.channels.cache.get(config.botVCchannel);
			const parentCategory =
				lobbyVC?.parent ?? (lobbyVC?.parentId ? channel.guild.channels.cache.get(lobbyVC.parentId) : null);

			if (parentCategory && parentCategory.type === ChannelType.GuildCategory) {
				queueChannels.category = parentCategory;
			} else {
				queueChannels.category = await createCategory(channel.guild, `Queue #${queueNumber}`);
				createdCategory = true;
				await moveCategoryToBottom?.(channel.guild, queueChannels.category).catch(() => {});
			}

			queueChannels.text = await createTextChannel(channel.guild, queueChannels.category, `Queue #${queueNumber}`);
			queueChannels.voice = await createVoiceChannel(channel.guild, queueChannels.category, `Queue VC #${queueNumber}`);

			await moveUsersToVoiceChannel(channel.guild, queueChannels.voice, config.botVCchannel, queue);

			let teams;
			try {
				teams = await draftStart(queue, config, queueChannels, channel.guild, queueNumber);

				matches.blue = await createVoiceChannel(channel.guild, queueChannels.category, `Blue VC #${queueNumber}`);
				matches.red = await createVoiceChannel(channel.guild, queueChannels.category, `Red VC #${queueNumber}`);

				await moveUsersToVoiceChannel(channel.guild, matches.blue, queueChannels.voice.id, teams.blue.picks);
				await moveUsersToVoiceChannel(channel.guild, matches.red, queueChannels.voice.id, teams.red.picks);

				await safeDelete(queueChannels.voice);

				state.queues.set(queueNumber, makeEmptyQueue());
				config.QueueNumber += 1;
				await config.save();

				const vote = await collectWinnerVoteFromTeams(queueChannels.text, {
					teams,
					threshold: voteThreshold,
					timeoutMs: voteTimeoutMs,
					blueName: 'Blue',
					redName: 'Red',
					prompt: 'Teams, please vote who won the match:',
				});

				const { points, mmr } = await applyMatchResult({
					serverID,
					teams,
					winner: vote.winner,
				});

				await queueChannels.text.send({
					embeds: [buildPointsUpdateEmbed(channel.guild, teams, points, vote.winner)],
				});

				const botVC = channel.guild.channels.cache.get(config.botVCchannel);
				await moveUsersToVoiceChannel(channel.guild, botVC, matches.blue.id, teams.blue.picks);
				await moveUsersToVoiceChannel(channel.guild, botVC, matches.red.id, teams.red.picks);

				await safeDelete(matches.blue);
				await safeDelete(matches.red);
			} catch (err) {
				await queueChannels.text?.send?.({ content: err?.message ?? 'Unexpected error during draft or match setup.' }).catch(() => {});
				await wait(deleteMediumMs);

				const botVC = channel.guild.channels.cache.get(config.botVCchannel);
				if (queueChannels.voice) {
					await moveUsersToVoiceChannel(channel.guild, botVC, queueChannels.voice.id, state.queues.get(queueNumber) ?? queue);
				} else if (matches.blue || matches.red) {
					try {
						if (matches.blue && err?.teams?.blue?.picks) {
							await moveUsersToVoiceChannel(channel.guild, botVC, matches.blue.id, err.teams.blue.picks);
						}
					} catch {}
					try {
						if (matches.red && err?.teams?.red?.picks) {
							await moveUsersToVoiceChannel(channel.guild, botVC, matches.red.id, err.teams.red.picks);
						}
					} catch {}
				}

				await safeDelete(queueChannels.text);
				await safeDelete(queueChannels.voice);
				await safeDelete(matches.blue);
				await safeDelete(matches.red);
				if (createdCategory) await safeDelete(queueChannels.category);

				state.queues.set(queueNumber, makeEmptyQueue());
				return;
			}
		} finally {
			await cleanupAll(createdCategory);
		}
	});
}

module.exports = { writeCustomQueue, bumpQueueMessage };
