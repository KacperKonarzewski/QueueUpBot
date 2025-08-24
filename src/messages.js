const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType, MessageFlags } = require('discord.js');
const Config = require('../models/Config');

//--------------------------------------------

const clearPreviousMessage = async (channel, config) => {
	if (config?.lastQueueMessageID) {
		try {
			const oldMessage = await channel.messages.fetch(config.lastQueueMessageID);
			if (oldMessage) await oldMessage.delete();
		} catch (err) {
			console.warn('No previous queue message to delete or could not fetch:', err.message);
		}
	}
};

//--------------------------------------------

const ROLE_ORDER = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];
const ROLE_LABEL = { Top:'Top', Jungle:'Jungle', Mid:'Mid', ADC:'ADC', Support:'Support' };

const teamIds = (teams, key) => ROLE_ORDER.map(r => teams[key]?.picks?.[r]).filter(Boolean);

const fmtSign = (n) => (n > 0 ? `+${n}` : `${n}`);
const arrow = (n) => (n > 0 ? '▲' : (n < 0 ? '▼' : '•'));

const buildPointsUpdateEmbed = (guild, teams, points, winner) => {
	const blueIds = teamIds(teams, 'blue');
	const redIds = teamIds(teams, 'red');

	const display = (id) => {
		const m = guild.members.cache.get(id);
		return m?.displayName || m?.user?.username || id;
	};

	const lineFor = (roleKey, id) => {
		const d = points.deltas[id] ?? 0;
		const after = points.after[id] ?? 500;
		const before = after - d;
		return `**${ROLE_LABEL[roleKey]}:** <@${id}>  \`${before} → ${after}\`  (**${fmtSign(d)}** ${arrow(d)})`;
	};

	const renderTeam = (key) => {
		return ROLE_ORDER.map(role => {
			const id = teams[key]?.picks?.[role];
			return id ? lineFor(role, id) : `**${ROLE_LABEL[role]}:** —`;
		}).join('\n');
	};

	const sum = (ids) => ids.reduce((a, id) => a + (points.deltas[id] ?? 0), 0);
	const blueSum = sum(blueIds);
	const redSum = sum(redIds);

	const color = winner === 'blue' ? 0x3498db : 0xe74c3c;

	return new EmbedBuilder()
		.setTitle('🏅 Match Result — Points Update')
		.setDescription(
			`Winner: ${winner === 'blue' ? '🔵 **Blue**' : '🔴 **Red**'}\n` +
			`_Below are POINTS (public rating) changes per player._`
		)
		.addFields(
			{ name: `🔵 Blue — Total ${fmtSign(blueSum)}`, value: renderTeam('blue'), inline: false },
			{ name: `🔴 Red — Total ${fmtSign(redSum)}`, value: renderTeam('red'), inline: false },
		)
		.setColor(color)
		.setFooter({ text: 'Note: hidden MMR was also updated under the hood.' });
}

const teamMemberIds = (team) =>
	ROLE_ORDER.map(r => team?.picks?.[r]).filter(Boolean);

const renderRoster = (team) =>
	ROLE_ORDER.map(r => `**${r}:** ${team?.picks?.[r] ? `<@${team.picks[r]}>` : '—'}`).join('\n');

const collectWinnerVoteFromTeams = async (channel, opts) => {
	const {
		teams,
		threshold = 6,
		timeoutMs = 7_200_000,
		prompt = 'Vote which team won the match:',
		blueName = 'Blue',
		redName = 'Red',
	} = opts;

	const blueIds = teamMemberIds(teams.blue);
	const redIds = teamMemberIds(teams.red);

	const eligible = new Set([...blueIds, ...redIds]);

	const votes = new Map();
	const counts = { blue: 0, red: 0 };

	const voters = {
		blue: () => [...votes.entries()].filter(([, v]) => v === 'blue').map(([uid]) => uid),
		red: () => [...votes.entries()].filter(([, v]) => v === 'red').map(([uid]) => uid),
	};

	const buildEmbed = () => new EmbedBuilder()
		.setTitle('🏁 Match Result Vote')
		.setDescription([
			prompt,
			'',
			`**${blueName}** votes: **${counts.blue} / ${threshold}**`,
			`**${redName}** votes: **${counts.red} / ${threshold}**`,
			'',
			`**${blueName} roster**\n${renderRoster(teams.blue)}`,
			'',
			`**${redName} roster**\n${renderRoster(teams.red)}`,
			'',
			'_Only players from these teams can vote. You can change or clear your vote._'
		].join('\n'))
		.addFields(
			{ name: `${blueName} voters`, value: voters.blue().map(id => `<@${id}>`).join(', ') || '—', inline: false },
			{ name: `${redName} voters`, value: voters.red().map(id => `<@${id}>`).join(', ') || '—', inline: false },
		)
		.setColor(0x5865F2);

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('vote_blue').setLabel(`${blueName} Won`).setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId('vote_red').setLabel(`${redName} Won`).setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId('vote_clear').setLabel('Clear my vote').setStyle(ButtonStyle.Secondary),
	);

	const msg = await channel.send({ embeds: [buildEmbed()], components: [row] });

	const endWith = async (winner, reason) => {
		const disabledRow = new ActionRowBuilder().addComponents(
			row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
		);
		const final = new EmbedBuilder(buildEmbed().data)
			.setFooter({ text: winner ? `Winner: ${winner === 'blue' ? blueName : redName}` : 'No side reached the threshold' })
			.setColor(winner ? (winner === 'blue' ? 0x3498db : 0xe74c3c) : 0xf1c40f);

		try { await msg.edit({ embeds: [final], components: [disabledRow] }); } catch { }
		return {
			winner: winner ?? null,
			counts: { ...counts },
			voters: { blue: voters.blue(), red: voters.red() },
			reason
		};
	};

	return await new Promise((resolve) => {
		const collector = msg.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: timeoutMs
		});

		collector.on('collect', async (i) => {
			const uid = i.user.id;

			if (!eligible.has(uid)) {
				return i.reply({ content: '❌ Only players from these teams can vote on the result.', ephemeral: true });
			}

			if (i.customId === 'vote_clear') {
				const prev = votes.get(uid);
				if (!prev) return i.reply({ content: 'You have no vote to clear.', ephemeral: true });
				counts[prev]--;
				votes.delete(uid);
				await i.update({ embeds: [buildEmbed()], components: [row] });
				return;
			}

			const choice = i.customId === 'vote_blue' ? 'blue' : i.customId === 'vote_red' ? 'red' : null;
			if (!choice) return i.deferUpdate();

			const prev = votes.get(uid);
			if (prev === choice) {
				return i.reply({ content: `You already voted for ${choice === 'blue' ? blueName : redName}.`, ephemeral: true });
			}

			if (prev) counts[prev]--;
			votes.set(uid, choice);
			counts[choice]++;

			await i.update({ embeds: [buildEmbed()], components: [row] });

			if (counts[choice] >= threshold) {
				collector.stop(`win:${choice}`);
			}
		});

		collector.on('end', async (_collected, reason) => {
			if (reason?.startsWith('win:')) {
				const winner = reason.split(':')[1] === 'blue' ? 'blue' : 'red';
				const payload = await endWith(winner, 'threshold');
				return resolve(payload);
			}
			endWith(null, 'timeout').then(resolve);
		});
	});
}
//--------------------------------------------

const generateWaitEmbed = (members, voiceChannel, endAt) => {
	const missing = members.filter(m => m.voice.channelId !== voiceChannel.id);
	const ready = members.filter(m => m.voice.channelId === voiceChannel.id);

	const embed = new EmbedBuilder()
		.setTitle('⏰ Waiting for players to join')
		.setDescription(`Voice Channel: **${voiceChannel.name}**`)
		.setColor(missing.length > 0 ? 0xffa500 : 0x1f8b4c);

	if (missing.length > 0) {
		const endTs = Math.floor(endAt / 1000);
		embed.addFields(
			{
				name: `✅ Joined (${ready.length}/${members.length})`,
				value: ready.length > 0 ? ready.map(m => `<@${m.id}>`).join(', ') : 'None yet',
				inline: false,
			},
			{
				name: `⌛ Still Missing (${missing.length})`,
				value: missing.map(m => `<@${m.id}>`).join(', '),
				inline: false,
			},
			{
				name: '⏳ Time left',
				value: `<t:${endTs}:R>`,
				inline: false,
			}
		);
	} else {
		embed.setDescription(`✅ All members have joined **${voiceChannel.name}**!`);
	}

	return embed;
};

//--------------------------------------------

const generateQueue = (queue, config) => {
	const header = config?.queueHeader || '🎮 Custom 5vs5 Queue 🎮';

	const roles = [
		['Top', queue.Top],
		['Jungle', queue.Jg],
		['Mid', queue.Mid],
		['ADC', queue.Adc],
		['Support', queue.Supp],
	];

	const embed = new EmbedBuilder()
		.setTitle(header)
		.setColor(0x1f8b4c);

	for (const [label, arr] of roles) {
		const s1 = arr[0] ? `<@${arr[0]}>` : 'Empty';
		const s2 = arr[1] ? `<@${arr[1]}>` : 'Empty';

		embed.addFields({
			name: `**${label} (${arr.length}/2)**`,
			value: `${s1} | ${s2}`,
			inline: false,
		});
	}

	return embed;
};

//--------------------------------------------

const sendDraftLinks = async (channel, links) => {
	await channel.send({
		embeds: [new EmbedBuilder().setTitle('Draft links:').setDescription(
			`**Blue Team:** ${links.Blue}\n\n**Red Team:** ${links.Red}\n\n**Spectator:** ${links.Spectator}`
		).setColor(0x1f8b4c)],
	});
};

//--------------------------------------------

const generateVoting = (queue, config) => {
	const header = ':crown: Capitans Voting :crown:';

	const roles = [
		['Top', queue.Top],
		['Jungle', queue.Jg],
		['Mid', queue.Mid],
		['ADC', queue.Adc],
		['Support', queue.Supp],
	];

	const embed = new EmbedBuilder()
		.setTitle(header)
		.setColor(0x1f8b4c);

	for (const [label, arr] of roles) {
		const s1 = arr[0];
		const s2 = arr[1];

		embed.addFields({
			name: `**${label}**`,
			value: `${s1} | ${s2}`,
			inline: false,
		});
	}

	return embed;
};
//--------------------------------------------

const createButtons = () => {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId('join_queue')
			.setLabel('Join Queue')
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId('leave_queue')
			.setLabel('Leave Queue')
			.setStyle(ButtonStyle.Danger)
	);
};

//--------------------------------------------

const createRoleButtons = (queue) => {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId('role_Top')
			.setLabel('Top')
			.setStyle(ButtonStyle.Primary)
			.setDisabled(queue.Top.length >= 2),
		new ButtonBuilder()
			.setCustomId('role_Jg')
			.setLabel('Jg')
			.setStyle(ButtonStyle.Primary)
			.setDisabled(queue.Jg.length >= 2),
		new ButtonBuilder()
			.setCustomId('role_Mid')
			.setLabel('Mid')
			.setStyle(ButtonStyle.Primary)
			.setDisabled(queue.Mid.length >= 2),
		new ButtonBuilder()
			.setCustomId('role_Adc')
			.setLabel('Adc')
			.setStyle(ButtonStyle.Primary)
			.setDisabled(queue.Adc.length >= 2),
		new ButtonBuilder()
			.setCustomId('role_Supp')
			.setLabel('Supp')
			.setStyle(ButtonStyle.Primary)
			.setDisabled(queue.Supp.length >= 2)
	);
};

module.exports = {
	clearPreviousMessage,
	generateQueue,
	createButtons,
	createRoleButtons,
	generateVoting,
	sendDraftLinks,
	generateWaitEmbed,
	collectWinnerVoteFromTeams,
	buildPointsUpdateEmbed
};