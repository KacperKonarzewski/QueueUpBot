const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType, MessageFlags } = require('discord.js');
const Player = require('../../models/Player');

const ROLE_ORDER = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];

const getQueueMemberIds = (queue) => {
	return [...queue.Top, ...queue.Jg, ...queue.Mid, ...queue.Adc, ...queue.Supp];
};

const makeBuckets = (candidates) => {
	const buckets = Object.fromEntries(ROLE_ORDER.map(r => [r, []]));
	for (const c of candidates) {
		const role = c.lane;
		if (buckets[role] && buckets[role].length < 2) buckets[role].push(c);
	}
	return buckets;
};

const buildVoteButtons = (buckets, selectedIds = []) => {
	const makeRow = (teamIdx) => {
		const row = new ActionRowBuilder();
		for (const role of ROLE_ORDER) {
			const c = buckets[role][teamIdx];
			if (c) {
				const chosen = selectedIds.includes(c.id);
				row.addComponents(
					new ButtonBuilder()
						.setCustomId(`vote:${c.id}`)
						.setLabel(c.label)
						.setStyle(chosen ? ButtonStyle.Primary : ButtonStyle.Secondary)
				);
			} else {
				row.addComponents(
					new ButtonBuilder()
						.setCustomId(`noop:${role}:${teamIdx}`)
						.setLabel(role)
						.setStyle(ButtonStyle.Secondary)
						.setDisabled(true)
				);
			}
		}
		return row;
	};

	return [makeRow(0), makeRow(1)];
};

const buildQuickRoleRow = (buckets, selectedIds = []) => {
	const row = new ActionRowBuilder();
	for (const role of ROLE_ORDER) {
		const pair = (buckets[role] || []).map(c => c.id);
		const isSelectedPair =
			pair.length > 0 &&
			selectedIds.length === pair.length &&
			pair.every(id => selectedIds.includes(id));

		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`rolepick:${role}`)
				.setLabel(role)
				.setStyle(isSelectedPair ? ButtonStyle.Success : ButtonStyle.Secondary)
		);
	}
	return row;
};

const tallyVotes = (candidates, votes) => {
	const counts = new Map(candidates.map(c => [c.id, 0]));
	for (const arr of votes.values()) {
		if (!Array.isArray(arr)) continue;
		for (const cid of arr) {
			if (counts.has(cid)) counts.set(cid, counts.get(cid) + 1);
		}
	}
	return counts;
};

const buildVoteEmbed = (candidates, votes, endAt, gamesAmount) => {
	const counts = tallyVotes(candidates, votes);
	const totalVotes = [...counts.values()].reduce((a, b) => a + b, 0);
	const lines = candidates.map((c, idx) => {
		const count = counts.get(c.id) ?? 0;
		const bar = '█'.repeat(Math.min(count, 10)).padEnd(10, '░');
		const games = (gamesAmount[c.id]) ? gamesAmount[c.id] : 0;
		return `**${idx + 1}. ${c.lane}** (${games} Games) <@${c.id}> — **${count}** votes | \`${bar}\``;
	});
	const endTs = Math.floor(endAt / 1000);

	return new EmbedBuilder()
		.setTitle('🗳️ Vote for Captains')
		.setDescription(
			[
				'Click **Open Voting Panel** to cast/change your vote.',
				'Use the **role buttons** to instantly vote for both candidates of that role.',
				'Only the 10 queued players can vote.',
				'',
				lines.join('\n\n')
			].join('\n')
		)
		.addFields(
			{ name: '🧮 Total votes', value: `${totalVotes}`, inline: true },
			{ name: '⏳ Time left', value: `<t:${endTs}:R>`, inline: true },
		)
		.setColor(0x1f8b4c);
};

const openPanelButton = () => {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId('open_panel')
			.setLabel('Open Voting Panel')
			.setStyle(ButtonStyle.Primary)
			.setEmoji('🗳️')
	);
};

//--------------------------------------------

const startCaptainVote = async (textChannel, guild, queue, durationMs = 60000) => {
	const ids = getQueueMemberIds(queue);
	if (ids.length !== 10) {
		throw new Error(`Expected 10 queued players, got ${ids.length}`);
	}

	const rows = await Player.find({ serverID: guild.id, discordID: { $in: ids } })
		.select('discordID matchWins matchLosses')
		.lean();
	const gamesAmount = Object.fromEntries(
		rows.map(({ discordID, matchWins, matchLosses }) => [
			discordID,
			(matchWins ?? 0) + (matchLosses ?? 0),
		])
	);

	const candidates = ids.map(id => {
		const lane =
			queue.Top.includes(id) ? 'Top' :
			queue.Jg.includes(id) ? 'Jungle' :
			queue.Mid.includes(id) ? 'Mid' :
			queue.Adc.includes(id) ? 'ADC' :
			queue.Supp.includes(id) ? 'Support' : 'Unknown';
		const m = guild.members.cache.get(id);
		const raw = m?.displayName || m?.user?.username || id.slice(0, 10);
		const label = raw.length > 28 ? raw.slice(0, 28) : raw;
		return { id, lane, label };
	});

	const buckets = makeBuckets(candidates);

	const votes = new Map();
	const panels = new Map();

	const endAt = Date.now() + durationMs;
	let lastEditAt = 0;
	let message = await textChannel.send({
		embeds: [buildVoteEmbed(candidates, votes, endAt, gamesAmount)],
		components: [openPanelButton()]
	});

	const collector = message.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: durationMs
	});

	const editMainEmbedThrottled = async () => {
		const now = Date.now();
		if (now - lastEditAt < 1200) return;
		lastEditAt = now;
		try {
			await message.edit({
				embeds: [buildVoteEmbed(candidates, votes, endAt, gamesAmount)]
			});
		} catch {}
	};

	collector.on('collect', async (i) => {
		if (!i.deferred && !i.replied) {
			await i.deferUpdate().catch(() => {});
		}

		if (!ids.includes(i.user.id)) {
			return i.followUp({ content: '❌ Only queued players can vote.', flags: MessageFlags.Ephemeral }).catch(() => {});
		}

		if (i.customId === 'open_panel') {
			const voterId = i.user.id;
			if (!votes.has(voterId)) votes.set(voterId, []);

			const picks = votes.get(voterId);
			const existing = panels.get(voterId);

			const components = [
				...buildVoteButtons(buckets, picks),
				buildQuickRoleRow(buckets, picks)
			];

			if (existing) {
				try {
					await i.followUp({
						content: `Your current votes: ${picks.map(id => `<@${id}>`).join(', ') || 'none'}`,
						components,
						flags: MessageFlags.Ephemeral
					});
				} catch {
					const panel = await i.followUp({
						content: `Your current votes: ${picks.map(id => `<@${id}>`).join(', ') || 'none'}`,
						components,
						flags: MessageFlags.Ephemeral,
						fetchReply: true
					}).catch(() => null);
					if (panel) panels.set(voterId, panel);
				}
			} else {
				const panel = await i.followUp({
					content: `Your current votes: ${picks.map(id => `<@${id}>`).join(', ') || 'none'}`,
					components,
					flags: MessageFlags.Ephemeral,
					fetchReply: true
				}).catch(() => null);
				if (panel) panels.set(voterId, panel);

				if (panel) {
					const userCollector = panel.createMessageComponentCollector({
						componentType: ComponentType.Button,
						time: Math.max(0, endAt - Date.now()),
						filter: ii => ii.user.id === voterId
					});

					userCollector.on('collect', async (ii) => {
						if (!ii.deferred && !ii.replied) {
							await ii.deferUpdate().catch(() => {});
						}

						const [kind, arg] = ii.customId.split(':');

						if (kind === 'vote') {
							const candidateId = arg;
							const picks = votes.get(voterId) || [];
							const idx = picks.indexOf(candidateId);
							if (idx >= 0) {
								picks.splice(idx, 1);
							} else {
								if (picks.length >= 2) {
									return ii.followUp({ content: '⚠️ You already selected 2 captains. Unselect one first.', flags: MessageFlags.Ephemeral }).catch(() => {});
								}
								picks.push(candidateId);
							}
							votes.set(voterId, picks);

							const comps = [
								...buildVoteButtons(buckets, picks),
								buildQuickRoleRow(buckets, picks)
							];

							try {
								await panel.edit({
									content: `Your current votes: ${picks.map(id => `<@${id}>`).join(', ') || 'none'}`,
									components: comps
								});
							} catch {}
							return editMainEmbedThrottled();
						}

						if (kind === 'rolepick') {
							const role = arg;
							const pair = (buckets[role] || []).map(c => c.id).slice(0, 2);
							const picks = pair;
							votes.set(voterId, picks);

							const comps = [
								...buildVoteButtons(buckets, picks),
								buildQuickRoleRow(buckets, picks)
							];

							try {
								await panel.edit({
									content: `Your current votes: ${picks.map(id => `<@${id}>`).join(', ') || 'none'}`,
									components: comps
								});
							} catch {}
							return editMainEmbedThrottled();
						}
					});

					userCollector.on('end', async () => {
						try { await panel.edit({ components: [] }); } catch {}
					});
				}
			}
			return editMainEmbedThrottled();
		}

	});

	return await new Promise((resolve) => {
		collector.on('end', async () => {
			const counts = tallyVotes(candidates, votes);
			const sorted = [...counts.entries()].sort((a, b) => {
				if (b[1] !== a[1]) return b[1] - a[1];
				return a[0].localeCompare(b[0]);
			});
			const top2 = sorted.slice(0, 2).map(([cid]) => cid);

			const finalEmbed = new EmbedBuilder()
				.setTitle('🏆 Captains Selected')
				.setDescription(
					(top2.length >= 2)
						? `**Captain 1:** <@${top2[0]}>\n**Captain 2:** <@${top2[1]}>\n\nThanks for voting!`
						: `Not enough votes to pick 2 captains.`
				)
				.setColor(0x00b894);

			try {
				await message.edit({ embeds: [finalEmbed], components: [] });
			} catch {}

			resolve(top2);
		});
	});
};

module.exports = {
	startCaptainVote,
};
