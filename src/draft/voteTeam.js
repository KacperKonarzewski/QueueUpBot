const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType, MessageFlags } = require('discord.js');
const Player = require('../../models/Player');

const ROLE_ORDER = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];

const getQueueMemberIds = (queue) => [
	...queue.Top, ...queue.Jg, ...queue.Mid, ...queue.Adc, ...queue.Supp
];

const bucketByLane = (candidates) => {
	const buckets = Object.fromEntries(ROLE_ORDER.map(r => [r, []]));
	for (const c of candidates) if (buckets[c.lane]) buckets[c.lane].push(c);
	for (const r of ROLE_ORDER) buckets[r] = buckets[r].slice(0, 2);
	return buckets;
};

const ownsPlayer = (teamState, playerId) =>
	playerId === teamState.captain || Object.values(teamState.picks).includes(playerId);

const mapById = (arr) => Object.fromEntries(arr.map(x => [x.id, x]));
const laneOf = (id, byId) => byId[id]?.lane || 'Unknown';
const labelOf = (id, byId) => byId[id]?.label || id.slice(0, 10);

const buildDraftButtons = (buckets, teams, currentTeam) => {
	const rows = [];
	for (let rowIdx = 0; rowIdx < 2; rowIdx++) {
		const row = new ActionRowBuilder();
		for (const role of ROLE_ORDER) {
			const c = buckets[role][rowIdx];

			const laneResolved = !!(teams.blue.picks[role] && teams.red.picks[role]);
			if (!c || laneResolved) {
				row.addComponents(
					new ButtonBuilder()
						.setCustomId(`noop:${role}:${rowIdx}`)
						.setLabel(role)
						.setStyle(ButtonStyle.Secondary)
						.setDisabled(true)
				);
				continue;
			}

			const ownedByBlue = ownsPlayer(teams.blue, c.id);
			const ownedByRed = ownsPlayer(teams.red, c.id);
			const taken = ownedByBlue || ownedByRed;

			let style = ButtonStyle.Secondary;
			if (ownedByBlue) style = ButtonStyle.Primary;
			if (ownedByRed) style = ButtonStyle.Danger;

			row.addComponents(
				new ButtonBuilder()
					.setCustomId(`pick:${c.id}`)
					.setLabel(c.label)
					.setStyle(style)
					.setDisabled(taken)
			);
		}
		rows.push(row);
	}
	return rows;
};

const renderTeamLines = (team, pointsById) =>
	ROLE_ORDER.map(role => {
		const pid = team.picks[role];
		const points = pid ? (pointsById[pid] ?? 'unknown') : null;
		const text = pid ? `<@${pid}> (${points})` : '—';
		return `**${role}:** ${text}`;
	}).join('\n');

const buildDraftEmbed = (candidates, teams, currentTeam, turnEndAt, pointsById) => {
	const byId = mapById(candidates);
	const endTs = Math.floor(turnEndAt / 1000);
	const picksDoneBlue = Object.keys(teams.blue.picks).length;
	const picksDoneRed = Object.keys(teams.red.picks).length;
	const lanesResolved = ROLE_ORDER.filter(r => teams.blue.picks[r] && teams.red.picks[r]).length;
	const remaining = 5 - lanesResolved;

	return new EmbedBuilder()
		.setTitle('🛡️ Captain Draft (Lane Mirror)')
		.setDescription([
			`**On the pick:** ${currentTeam === 'blue' ? '🔵 Blue Nexus' : '🔴 Red Nexus'}`,
			`**Lane decisions remaining:** ${remaining}`,
			`**Time left:** <t:${endTs}:R>`,
			'',
			`**🔵 Blue (Captain: <@${teams.blue.captain}> — ${labelOf(teams.blue.captain, byId)})**`,
			renderTeamLines(teams.blue, pointsById),
			'',
			`**🔴 Red (Captain: <@${teams.red.captain}> — ${labelOf(teams.red.captain, byId)})**`,
			renderTeamLines(teams.red, pointsById),
			'',
			'_Pick any player from an unresolved lane; the other player of that lane automatically goes to the opposite team._'
		].join('\n'))
		.setColor(currentTeam === 'blue' ? 0x3498db : 0xe74c3c)
		.addFields(
			{ name: 'Blue roles filled', value: `${picksDoneBlue}/5`, inline: true },
			{ name: 'Red roles filled', value: `${picksDoneRed}/5`, inline: true },
		);
};

const startCaptainDraft = async (textChannel, queue, captains, durationMs = 30000) => {
	const guild = textChannel.guild;
	const ids = getQueueMemberIds(queue);
	if (ids.length !== 10) throw new Error(`Expected 10 queued players, got ${ids.length}`);

	const candidates = ids.map(id => {
		const lane =
			queue.Top.includes(id) ? 'Top' :
			queue.Jg.includes(id) ? 'Jungle' :
			queue.Mid.includes(id) ? 'Mid' :
			queue.Adc.includes(id) ? 'ADC' :
			queue.Supp.includes(id) ? 'Support' : 'Unknown';
		const m = guild.members.cache.get(id);
		const label = m?.displayName || m?.user?.username || id.slice(0, 10);
		return { id, lane, label: label.length > 28 ? label.slice(0, 28) : label };
	});

	const rows = await Player.find({ serverID: guild.id, discordID: { $in: ids } })
		.select('discordID points')
		.lean();
	const pointsById = Object.fromEntries(rows.map(r => [r.discordID, r.points ?? 500]));

	let capA, capB;
	if (Array.isArray(captains) && captains.length === 2) {
		[capA, capB] = captains;
	} else {
		const shuffled = [...ids].sort(() => Math.random() - 0.5);
		[capA, capB] = shuffled.slice(0, 2);
	}

	const blueCap = (pointsById[capA] ?? 500) <= (pointsById[capB] ?? 500) ? capA : capB;
	const redCap  = blueCap === capA ? capB : capA;

	const byId = mapById(candidates);

	const teams = {
		blue: { captain: blueCap, picks: {} },
		red:  { captain: redCap,  picks: {} },
	};

	const buckets = bucketByLane(candidates);

	const resolveLaneWithPair = (role, chosenId, chooserTeam) => {
		if (!ROLE_ORDER.includes(role)) return;
		if (teams.blue.picks[role] || teams.red.picks[role]) return;

		const pair = (buckets[role] || []).map(c => c.id);
		if (!pair.includes(chosenId)) return;

		const otherTeam = chooserTeam === 'blue' ? 'red' : 'blue';
		teams[chooserTeam].picks[role] = chosenId;

		const otherId = pair.find(id => id !== chosenId);
		if (otherId) {
			teams[otherTeam].picks[role] = otherId;
		}

		buckets[role] = [];
	};

	const blueCapRole = laneOf(blueCap, byId);
	if (ROLE_ORDER.includes(blueCapRole)) {
		resolveLaneWithPair(blueCapRole, blueCap, 'blue');
	}
	const redCapRole = laneOf(redCap, byId);
	if (ROLE_ORDER.includes(redCapRole)) {
		resolveLaneWithPair(redCapRole, redCap, 'red');
	}

	let currentTeam = 'blue';
	let turnEndAt = Date.now() + durationMs;
	let turnTimer = null;

	const lanesResolved = () => ROLE_ORDER.filter(r => teams.blue.picks[r] && teams.red.picks[r]).length;
	const allResolved = () => lanesResolved() >= 5;

	let message = await textChannel.send({
		embeds: [buildDraftEmbed(candidates, teams, currentTeam, turnEndAt, pointsById)],
		components: buildDraftButtons(buckets, teams, currentTeam)
	});

	const refresh = async () => {
		await message.edit({
			embeds: [buildDraftEmbed(candidates, teams, currentTeam, turnEndAt, pointsById)],
			components: buildDraftButtons(buckets, teams, currentTeam)
		}).catch(() => {});
	};

	const armTurnTimer = () => {
		if (turnTimer) clearTimeout(turnTimer);
		turnEndAt = Date.now() + durationMs;
		turnTimer = setTimeout(onTurnExpired, durationMs);
	};

	const finish = async () => {
		if (turnTimer) clearTimeout(turnTimer);
		collector.stop('done');
		const finalEmbed = new EmbedBuilder()
			.setTitle('🏆 Teams Locked')
			.setDescription([
				`**🔵 Blue Captain:** <@${teams.blue.captain}>`,
				renderTeamLines(teams.blue, pointsById),
				'',
				`**🔴 Red Captain:** <@${teams.red.captain}>`,
				renderTeamLines(teams.red, pointsById),
			].join('\n'))
			.setColor(0x2ecc71);
		await message.edit({ embeds: [finalEmbed], components: [] }).catch(() => {});
	};

	const resolveLaneByPick = (pickedId, chooserTeam) => {
		const role = laneOf(pickedId, byId);
		if (!ROLE_ORDER.includes(role)) return null;

		if (teams.blue.picks[role] && teams.red.picks[role]) return null;

		resolveLaneWithPair(role, pickedId, chooserTeam);
		return role;
	};

	const onTurnExpired = async () => {
		const unresolved = ROLE_ORDER.filter(r => !(teams.blue.picks[r] && teams.red.picks[r]));
		if (unresolved.length > 0) {
			const role = unresolved[0];
			const pair = (buckets[role] || []).map(c => c.id);

			if (pair.length > 0) {
				let pickId = pair[0];
				if (pair.length === 2) {
					const [a, b] = pair;
					pickId = (pointsById[a] ?? 500) <= (pointsById[b] ?? 500) ? a : b;
				}
				resolveLaneWithPair(role, pickId, currentTeam);
				await textChannel.send(`⏰ Time ran out for ${currentTeam === 'blue' ? '🔵 Blue' : '🔴 Red'} captain <@${teams[currentTeam].captain}> — auto-resolved **${role}**.`).catch(() => {});
			}
		}

		if (allResolved()) return finish();
		currentTeam = currentTeam === 'blue' ? 'red' : 'blue';
		armTurnTimer();
		await refresh();
	};

	if (allResolved()) {
		await finish();
		return {
			blue: { captain: teams.blue.captain, picks: teams.blue.picks },
			red:  { captain: teams.red.captain,  picks: teams.red.picks  }
		};
	}
	armTurnTimer();

	const collector = message.createMessageComponentCollector({
		componentType: ComponentType.Button
	});

	collector.on('collect', async (i) => {
		if (!i.deferred && !i.replied) {
			await i.deferUpdate().catch(() => {});
		}

		const userId = i.user.id;
		const requiredCaptain = teams[currentTeam].captain;

		if (userId !== requiredCaptain) {
			return i.followUp({ content: `❌ It’s not your turn. It’s <@${requiredCaptain}>’s pick.`, flags: MessageFlags.Ephemeral }).catch(() => {});
		}

		const [kind, candidateId] = i.customId.split(':');
		if (kind !== 'pick') return;

		if (!mapById(candidates)[candidateId]) {
			return i.followUp({ content: '❌ Unknown player.', flags: MessageFlags.Ephemeral }).catch(() => {});
		}
		if (ownsPlayer(teams.blue, candidateId) || ownsPlayer(teams.red, candidateId)) {
			return i.followUp({ content: '❌ That player is already taken.', flags: MessageFlags.Ephemeral }).catch(() => {});
		}

		const roleResolved = resolveLaneByPick(candidateId, currentTeam);
		if (!roleResolved) {
			return i.followUp({ content: '❌ That lane is already resolved.', flags: MessageFlags.Ephemeral }).catch(() => {});
		}

		if (allResolved()) return finish();
		currentTeam = currentTeam === 'blue' ? 'red' : 'blue';
		armTurnTimer();
		await refresh();
	});

	collector.on('end', async (_collected, reason) => {
		if (turnTimer) clearTimeout(turnTimer);
		if (reason === 'done') return;

		const expiredEmbed = new EmbedBuilder()
			.setTitle('⏰ Draft Ended')
			.setDescription([
				`**🔵 Blue Captain:** <@${teams.blue.captain}>`,
				renderTeamLines(teams.blue, pointsById),
				'',
				`**🔴 Red Captain:** <@${teams.red.captain}>`,
				renderTeamLines(teams.red, pointsById),
			].join('\n'))
			.setColor(0xf1c40f);

		try { await message.edit({ embeds: [expiredEmbed], components: [] }); } catch {}
	});

	return new Promise((resolve) => {
		collector.once('end', () => {
			resolve({
				blue: { captain: teams.blue.captain, picks: teams.blue.picks },
				red:  { captain: teams.red.captain,  picks: teams.red.picks  }
			});
		});
	});
};

module.exports = { startCaptainDraft };
