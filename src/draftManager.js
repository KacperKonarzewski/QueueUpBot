const { generateWaitEmbed, sendDraftLinks } = require('./messages');
const { startCaptainVote } = require('./draft/voteCaptain');
const { startCaptainDraft } = require('./draft/voteTeam');
const { createDraftLinks } = require('./draft/draftLol');

const waitForMembersInChannel = async (members, channels, queueNumber, timeoutMs = 300000) => {
	return new Promise(async (resolve, reject) => {
		const textChannel = channels.text ?? channels['text' + queueNumber];
		const voiceChannel = channels.voice ?? channels['voice' + queueNumber];

		if (!textChannel || !voiceChannel) {
			return reject(new Error('❌ Draft channels are missing.'));
		}

		const guild = textChannel.guild;

		const uniqueIds = Array.from(new Set(members.map(m => m?.id || m))).filter(Boolean);
		const resolvedMembers = (await Promise.all(
			uniqueIds.map(async (id) => guild.members.cache.get(id) || guild.members.fetch(id).catch(() => null))
		)).filter(Boolean);

		const endAt = Date.now() + timeoutMs;

		let statusMessage = null;
		try {
			statusMessage = await textChannel.send({ embeds: [generateWaitEmbed(resolvedMembers, voiceChannel, endAt)] });
		} catch (_) { }

		let lastMissingKey = null;
		let lastEditAt = 0;

		const everyoneReady = () =>
			resolvedMembers.every(m => m?.voice?.channelId === voiceChannel.id);

		const getMissing = () =>
			resolvedMembers.filter(m => m?.voice?.channelId !== voiceChannel.id);

		const updateStatus = async () => {
			if (!statusMessage?.editable) return;
			const now = Date.now();

			if (now - lastEditAt < 1500) return;
			lastEditAt = now;
			try {
				await statusMessage.edit({
					embeds: [generateWaitEmbed(resolvedMembers, voiceChannel, endAt)]
				});
			} catch (_) { }
		};

		const cleanup = () => {
			clearTimeout(timeoutTimer);
			clearInterval(pollInterval);
			guild.client.removeListener('voiceStateUpdate', onVoiceStateUpdate);
		};

		const finishResolve = () => {
			cleanup();
			if (statusMessage?.deletable) {
				setTimeout(() => statusMessage.delete().catch(() => { }), 2000);
			}
			resolve();
		};

		const finishReject = (err) => {
			cleanup();
			try { updateStatus(); } catch { }
			reject(err);
		};

		const onVoiceStateUpdate = (oldState, newState) => {
			const uid = newState?.id || oldState?.id;
			if (!uniqueIds.includes(uid)) return;

			if (!guild.channels.cache.has(voiceChannel.id) || !guild.channels.cache.has(textChannel.id)) {
				return finishReject(new Error('❌ Draft channels were removed.'));
			}

			const missing = getMissing();
			const missingKey = missing.map(m => m.id).sort().join(',');
			if (missingKey !== lastMissingKey) {
				lastMissingKey = missingKey;
				if (everyoneReady()) return finishResolve();
				updateStatus();
			}
		};

		guild.client.on('voiceStateUpdate', onVoiceStateUpdate);

		const pollInterval = setInterval(() => {
			if (!guild.channels.cache.has(voiceChannel.id) || !guild.channels.cache.has(textChannel.id)) {
				return finishReject(new Error('❌ Draft channels were removed.'));
			}
			if (everyoneReady()) return finishResolve();

			const missing = getMissing();
			const missingKey = missing.map(m => m.id).sort().join(',');
			if (missingKey !== lastMissingKey) {
				lastMissingKey = missingKey;
				updateStatus();
			}
		}, 3000);

		const timeoutTimer = setTimeout(() => {
			const missing = getMissing();
			const list = missing.map(m => m.user?.tag ?? m.id).join(', ');
			finishReject(new Error(`❌ Not all members joined the voice channel in time: ${list || 'unknown'}`));
		}, timeoutMs);

		if (everyoneReady()) return finishResolve();
	});
};

const draftStart = async (queue, config, channels, guild, queueNumber) => {
	try {
		const ids = Object.values(queue).flat();
		const uniq = Array.from(new Set(ids));
		const members = (await Promise.all(
			uniq.map(async id => guild.members.cache.get(id) || guild.members.fetch(id).catch(() => null))
		)).filter(Boolean);

		const waitMs = Number.isFinite(config?.WaitForMembersTimeoutMs) ? config.WaitForMembersTimeoutMs : 300000;
		const voteMs = Number.isFinite(config?.CaptainsVoteTimeoutMs) ? config.CaptainsVoteTimeoutMs : 60000;

		await waitForMembersInChannel(members, channels, queueNumber, waitMs);

		const captains = await startCaptainVote(channels.text, guild, queue, voteMs);

		const teams = await startCaptainDraft(channels.text, queue, captains);

		try {
			const links = await createDraftLinks();
			await sendDraftLinks(channels.text, links);
		} catch (e) {
			console.error('createDraftLinks/sendDraftLinks failed:', e?.message || e);
		}

		return teams;
	} catch (err) {
		throw new Error(err?.message || 'Draft failed');
	}
};

module.exports = {
	draftStart
};
