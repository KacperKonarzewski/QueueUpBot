const { ComponentType, ChannelType, MessageFlags, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
const isAdmin = (member) => {
	return !!(
		member?.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
		member?.roles?.cache?.has?.('1386385941278621894')
	);
};

/* --------------------------------------------
 * Ephemeral helpers (auto-delete via webhook)
 * ------------------------------------------ */

// Always create EPHEMERAL FOLLOW-UP when possible; delete by id via webhook only.
async function sendEphemeral(i, payload, ttlMs) {
	const opts = { ...payload, flags: MessageFlags.Ephemeral, fetchReply: true };
	let msg = null;
	try {
		msg = await i.followUp(opts);
	} catch {
		try { msg = await i.reply(opts); } catch { return null; }
	}
	if (ttlMs && msg?.id) {
		setTimeout(() => { i.webhook?.deleteMessage?.(msg.id).catch(() => {}); }, ttlMs);
	}
	return msg;
}
async function replyEphemeral(interaction, payload, ttlMs) {
	let msg = null;
	try {
		msg = await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral, fetchReply: true });
	} catch {
		try { msg = await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral, fetchReply: true }); }
		catch { return null; }
	}
	if (ttlMs && msg?.id) {
		setTimeout(() => { interaction.webhook?.deleteMessage?.(msg.id).catch(() => {}); }, ttlMs);
	}
	return msg;
}
function deleteEphemeralBy(webhookOwnerInteraction, msg, delayMs = 0) {
	if (!msg?.id || !webhookOwnerInteraction?.webhook) return;
	setTimeout(() => { webhookOwnerInteraction.webhook.deleteMessage(msg.id).catch(() => {}); }, delayMs);
}

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
/*
state = {
	queues: Map<queueNumber, Queue>,
	channels: Map<queueNumber, Channels>,
	matches: Map<queueNumber, Matches>,
	queueMessages: Map<queueNumber, Message>
}
*/
function getGuildState(serverID) {
	if (!globalState.has(serverID)) {
		globalState.set(serverID, {
			queues: new Map(),
			channels: new Map(),
			matches: new Map(),
			queueMessages: new Map(),
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

/* --------------------------------------------
 * Admin kick helpers
 * ------------------------------------------ */

function listQueuedWithRoles(queue) {
	const out = [];
	for (const role of Object.keys(queue)) {
		for (const id of queue[role]) out.push({ id, role });
	}
	return out;
}

function buildAdminRow() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId('admin_kick_panel')
			.setLabel('Manage Queue')
			.setStyle(ButtonStyle.Primary)
			.setEmoji('🧹')
	);
}

function buildKickPanelComponents(guild, queue) {
	// Up to 10 players; 5 per row limit
	const entries = listQueuedWithRoles(queue);
	const rows = [];
	let row = new ActionRowBuilder();

	for (let i = 0; i < entries.length; i++) {
		const { id, role } = entries[i];
		const m = guild.members.cache.get(id);
		const label = (m?.displayName || m?.user?.username || id).slice(0, 80);
		if (row.components.length === 5) {
			rows.push(row);
			row = new ActionRowBuilder();
		}
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`kick:${id}`)
				.setLabel(`${label} — ${role}`)
				.setStyle(ButtonStyle.Danger)
		);
	}
	if (row.components.length) rows.push(row);

	// Add a close/cancel row if we have space
	const closeRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId('kick_close')
			.setLabel('Close')
			.setStyle(ButtonStyle.Secondary)
	);
	if (rows.length < 5) rows.push(closeRow);
	return rows;
}

/* --------------------------------------------
 * UI creation / bumping (NO RESET)
 * ------------------------------------------ */

async function createQueueMessage(channel, config, queue) {
	const msg = await channel.send({
		embeds: [generateQueue(queue, config)],
		components: [createButtons(), buildAdminRow()],
	});
	// Persist last message id
	config.lastQueueMessageID = msg.id;
	await config.save().catch(() => {});
	return msg;
}

function attachQueueCollector(queueMessage, { serverID, queueNumber, queue, config, onQueueFull }) {
	const collector = queueMessage.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: 0,
	});
	const lock = getLock(`${serverID}:${queueNumber}`);

	collector.on('collect', async (i) => {
		const userId = i.user.id;

		// Ack fast
		if (!i.deferred && !i.replied) {
			await i.deferUpdate().catch(() => {});
		}

		// --- ADMIN KICK PANEL OPEN ---
		if (i.customId === 'admin_kick_panel') {
			if (!isAdmin(i.member)) {
				await sendEphemeral(i, { content: '❌ You must be an admin to manage the queue.' }, maybeNumber(config.DeleteShortMs, 2000));
				return;
			}
			const rows = buildKickPanelComponents(i.guild, queue);
			if (rows.length === 0) {
				await sendEphemeral(i, { content: 'ℹ️ Queue is empty.' }, maybeNumber(config.DeleteShortMs, 2000));
				return;
			}
			const panel = await sendEphemeral(i, {
				content: '🧹 **Admin panel** — click a player to remove them from the queue:',
				components: rows
			}, null);

			if (!panel) return;

			const userCollector = panel.createMessageComponentCollector({
				componentType: ComponentType.Button,
				time: maybeNumber(config.DeleteMediumMs, 5000) + 20000, // ~25s panel lifetime
				filter: (ii) => ii.user.id === userId,
			});

			userCollector.on('collect', async (ii) => {
				// Only the admin who opened can use
				if (ii.customId === 'kick_close') {
					// Close panel by deleting the ephemeral
					try { await ii.update({ content: '✅ Closed.', components: [] }); } catch {}
					deleteEphemeralBy(i, panel, maybeNumber(config.DeleteShortMs, 2000));
					return;
				}
				const [kind, targetId] = ii.customId.split(':');
				if (kind !== 'kick' || !targetId) {
					await ii.deferUpdate().catch(() => {});
					return;
				}

				await lock.run(async () => {
					// Remove target from any role
					const removed = removeUserFromQueue(queue, targetId);
					if (removed) {
						// Update main message
						await queueMessage.edit({
							embeds: [generateQueue(queue, config)],
							components: [createButtons(), buildAdminRow()],
						}).catch(() => {});

						// Update the panel UI (rebuild list)
						const newRows = buildKickPanelComponents(ii.guild, queue);
						if (newRows.length === 0) {
							// No more players, close panel
							try { await ii.update({ content: '✅ Removed. Queue is now empty.', components: [] }); } catch {}
							deleteEphemeralBy(i, panel, maybeNumber(config.DeleteShortMs, 2000));
						} else {
							try {
								await ii.update({
									content: `✅ Removed <@${targetId}> from the queue.\nClick another to remove:`,
									components: newRows
								});
							} catch {}
						}
					} else {
						try {
							await ii.reply({ content: '⚠️ That user is not in the queue anymore.', flags: MessageFlags.Ephemeral });
						} catch {}
					}
				});
			});

			return; // handled
		}

		// --- NORMAL JOIN/LEAVE ---
		if (!['join_queue', 'leave_queue'].includes(i.customId)) return;

		await lock.run(async () => {
			let needsEdit = true;

			if (i.customId === 'join_queue') {
				if (Object.values(queue).flat().includes(userId)) {
					await sendEphemeral(i, { content: '❌ You are already in the queue!' }, maybeNumber(config.DeleteShortMs, 2000));
					return;
				}
				if (isQueueFull(queue, maybeNumber(config.PerRoleCapacity, 2))) {
					await sendEphemeral(i, { content: '❌ The queue is already full!' }, maybeNumber(config.DeleteShortMs, 2000));
					return;
				}

				const rolePromptMsg = await sendEphemeral(
					i,
					{ content: 'Choose your role:', components: [createRoleButtons(queue, maybeNumber(config.PerRoleCapacity, 2))] },
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
					await sendEphemeral(i, { content: '⏰ You did not pick a role in time.' }, maybeNumber(config.DeleteShortMs, 2000));
					return;
				}

				const role = roleInteraction.customId.replace('role_', '');

				if (Object.values(queue).flat().includes(userId)) {
					await replyEphemeral(roleInteraction, { content: '❌ You are already in the queue!' }, maybeNumber(config.DeleteShortMs, 2000));
					needsEdit = false;
					return;
				}
				if (!queue[role]) {
					await replyEphemeral(roleInteraction, { content: `❌ Unknown role: ${role}` }, maybeNumber(config.DeleteShortMs, 2000));
					needsEdit = false;
					return;
				}
				if (queue[role].length >= maybeNumber(config.PerRoleCapacity, 2)) {
					await replyEphemeral(roleInteraction, { content: `❌ The ${role} role is full!` }, maybeNumber(config.DeleteShortMs, 2000));
					needsEdit = false;
					return;
				}

				queue[role].push(userId);
				await replyEphemeral(roleInteraction, { content: `✅ You joined as ${role}!` }, maybeNumber(config.DeleteShortMs, 2000));
			} else if (i.customId === 'leave_queue') {
				const removed = removeUserFromQueue(queue, userId);
				if (removed) {
					await sendEphemeral(i, { content: '✅ You left the queue!' }, maybeNumber(config.DeleteShortMs, 2000));
				} else {
					await sendEphemeral(i, { content: '❌ You are not in the queue!' }, maybeNumber(config.DeleteShortMs, 2000));
				}
			}

			if (needsEdit) {
				await queueMessage.edit({
					embeds: [generateQueue(queue, config)],
					components: [createButtons(), buildAdminRow()],
				}).catch(() => {});
			}

			if (isQueueFull(queue, maybeNumber(config.PerRoleCapacity, 2))) {
				collector.stop('Queue is full');
			}
		});
	});

	collector.on('end', (_collected, reason) => {
		if (reason === 'Queue is full') {
			onQueueFull?.();
		}
	});
}

async function replaceQueueUIAtBottom(channel, config, queue, serverID, queueNumber) {
	const state = getGuildState(serverID);

	// Create new message at bottom
	const newMsg = await createQueueMessage(channel, config, queue);

	// Attach fresh collector bound to existing queue object
	attachQueueCollector(newMsg, {
		serverID,
		queueNumber,
		queue,
		config,
		onQueueFull: () => onQueueFullFlow({ channel, config, serverID, queueNumber })
	});

	// Delete old message (if any)
	const oldId = state.queueMessages.get(queueNumber)?.id || config.lastQueueMessageID;
	if (oldId && oldId !== newMsg.id) {
		const oldMsg = await channel.messages.fetch(oldId).catch(() => null);
		if (oldMsg) await oldMsg.delete().catch(() => {});
	}

	// Track the active message
	state.queueMessages.set(queueNumber, newMsg);
	return newMsg;
}

/* --------------------------------------------
 * Public: writeCustomQueue (INITIALIZE ONCE)
 * ------------------------------------------ */

async function writeCustomQueue(channel) {
	const serverID = channel.guild.id;
	const config = await Config.findOne({ serverID }) ?? new Config({ serverID });

	// config defaults / timers
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

	// Initialize queue/channels/matches ONLY if missing
	if (!state.queues.has(queueNumber)) state.queues.set(queueNumber, makeEmptyQueue());
	if (!state.channels.has(queueNumber)) state.channels.set(queueNumber, {});
	if (!state.matches.has(queueNumber)) state.matches.set(queueNumber, {});

	const queue = state.queues.get(queueNumber);

	// Clear the previous message (legacy) only on FIRST init
	await clearPreviousMessage(channel, config).catch(() => {});

	// Create UI at bottom (does NOT reset queue)
	const queueMessage = await replaceQueueUIAtBottom(channel, config, queue, serverID, queueNumber);

	// Done — collectors attached via replaceQueueUIAtBottom
	return queueMessage;
}

/* --------------------------------------------
 * Public: bump UI (NO RESET)
 * Call this from messageCreate when someone chats in botChannel
 * ------------------------------------------ */
async function bumpQueueUI(channel) {
	const serverID = channel.guild.id;
	const config = await Config.findOne({ serverID }).catch(() => null);
	if (!config) return;

	const queueNumber = typeof config.QueueNumber === 'number' ? config.QueueNumber : 1;
	const state = getGuildState(serverID);
	const queue = state.queues.get(queueNumber);
	if (!queue) return; // nothing active to render

	await replaceQueueUIAtBottom(channel, config, queue, serverID, queueNumber);
}

/* --------------------------------------------
 * Queue full -> play flow
 * ------------------------------------------ */

async function onQueueFullFlow({ channel, config, serverID, queueNumber }) {
	const deleteMediumMs = maybeNumber(config.DeleteMediumMs, 5000);
	const deleteLongMs = maybeNumber(config.DeleteLongMs, 10000);
	const voteThreshold = maybeNumber(config.VoteThreshold, 6);
	const voteTimeoutMs = maybeNumber(config.VoteTimeoutMs, 2 * 60 * 60 * 1000);

	const state = getGuildState(serverID);
	const queue = state.queues.get(queueNumber);
	const queueChannels = state.channels.get(queueNumber) ?? {};
	const matches = state.matches.get(queueNumber) ?? {};

	const mess = await channel.send({ content: 'The queue is now full! Starting the game...' }).catch(() => null);
	setTimeout(async () => { try { if (mess) await mess.delete(); } catch {} }, deleteMediumMs);

	let createdCategory = false;

	const cleanupAll = async () => {
		await wait(deleteLongMs);
		await safeDelete(queueChannels.text);
		if (createdCategory) await safeDelete(queueChannels.category);
		state.queues.delete(queueNumber);
		state.channels.delete(queueNumber);
		state.matches.delete(queueNumber);
		state.queueMessages.delete(queueNumber);
	};

	try {
		const lobbyVC = channel.guild.channels.cache.get(config.botChannel);
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

		try {
			const teams = await draftStart(queue, config, queueChannels, channel.guild, queueNumber);

			matches.blue = await createVoiceChannel(channel.guild, queueChannels.category, `Blue VC #${queueNumber}`);
			matches.red = await createVoiceChannel(channel.guild, queueChannels.category, `Red VC #${queueNumber}`);

			await moveUsersToVoiceChannel(channel.guild, matches.blue, queueChannels.voice.id, teams.blue.picks);
			await moveUsersToVoiceChannel(channel.guild, matches.red, queueChannels.voice.id, teams.red.picks);

			await safeDelete(queueChannels.voice);

			config.QueueNumber += 1;
			await config.save().catch(() => {});
			state.queues.set(config.QueueNumber, makeEmptyQueue());
			state.channels.set(config.QueueNumber, {});
			state.matches.set(config.QueueNumber, {});

			const vote = await collectWinnerVoteFromTeams(queueChannels.text, {
				teams,
				threshold: voteThreshold,
				timeoutMs: voteTimeoutMs,
				blueName: 'Blue',
				redName: 'Red',
				prompt: 'Teams, please vote who won the match:',
			});

			const { points } = await applyMatchResult({
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
				await moveUsersToVoiceChannel(channel.guild, botVC, queueChannels.voice.id, queue);
			} else if (matches.blue || matches.red) {
				try { if (matches.blue && err?.teams?.blue?.picks) await moveUsersToVoiceChannel(channel.guild, botVC, matches.blue.id, err.teams.blue.picks); } catch {}
				try { if (matches.red && err?.teams?.red?.picks) await moveUsersToVoiceChannel(channel.guild, botVC, matches.red.id, err.teams.red.picks); } catch {}
			}

			await safeDelete(queueChannels.text);
			await safeDelete(queueChannels.voice);
			await safeDelete(matches.blue);
			await safeDelete(matches.red);
			if (createdCategory) await safeDelete(queueChannels.category);
			return;
		}
	} finally {
		await cleanupAll();
	}
}

/* --------------------------------------------
 * Exports
 * ------------------------------------------ */
module.exports = {
	writeCustomQueue,
	bumpQueueUI,
};
