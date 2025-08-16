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

const generateWaitEmbed = (members, voiceChannel, start, timeout) => {
	const missing = members.filter(m => m.voice.channelId !== voiceChannel.id);
	const ready = members.filter(m => m.voice.channelId === voiceChannel.id);

	const embed = new EmbedBuilder()
		.setTitle(`⏰ Waiting for players to join`)
		.setDescription(`Voice Channel: **${voiceChannel.name}**`)
		.setColor(missing.length > 0 ? 0xffa500 : 0x1f8b4c);

	if (missing.length > 0) {
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
				value: `${Math.max(0, Math.ceil((timeout - (Date.now() - start)) / 1000))} seconds`,
				inline: false,
			}
		);
	} else {
		embed.setDescription(`✅ All members have joined **${voiceChannel.name}**!`);
	}

	return embed;
};

//--------------------------------------------

const getQueueMemberIds = (queue) => {
	return [...queue.Top, ...queue.Jg, ...queue.Mid, ...queue.Adc, ...queue.Supp];
};

const buildVoteButtons = (candidates, selectedIds = []) => {
	const roleOrder = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];

	const buckets = Object.fromEntries(roleOrder.map(r => [r, []]));
	for (const c of candidates) {
		const role = c.lane;
		if (buckets[role]) {
			if (buckets[role].length < 2) buckets[role].push(c);
		}
	}

	const makeRow = (teamIdx) => {
		const row = new ActionRowBuilder();
		for (const role of roleOrder) {
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

const tallyVotes = (candidates, votes) => {
	const counts = new Map(candidates.map(c => [c.id, 0]));
	for (const arr of Object.values(votes)) {
		if (!Array.isArray(arr)) continue;
		for (const cid of arr) {
			if (counts.has(cid)) counts.set(cid, counts.get(cid) + 1);
		}
	}
	return counts;
};

const buildVoteEmbed = (candidates, votes, endAt) => {
	const counts = tallyVotes(candidates, votes);
	const totalVotes =  [...counts.values()].reduce((a, b) => a + b, 0);
	const lines = candidates.map((c, idx) => {
		const count = counts.get(c.id) ?? 0;
		const bar = '█'.repeat(Math.min(count, 10)).padEnd(10, '░');
		return `**${idx + 1}. ${c.lane} ** <@${c.id}> — **${count}** votes | \`${bar}\``;
	});
	const endTs = Math.floor(endAt / 1000);

	return new EmbedBuilder()
		.setTitle('🗳️ Vote for Captains')
		.setDescription(
			[
				'Click a button below to cast/change your vote.',
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
}

const openPanelButton = () =>{
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId('open_panel')
			.setLabel('Open Voting Panel')
			.setStyle(ButtonStyle.Primary)
			.setEmoji('🗳️')
	);
}

//--------------------------------------------

const startCaptainVote = async (textChannel, guild, queue, durationMs = 60000) => {
	const ids = getQueueMemberIds(queue);
	if (ids.length !== 10) {
		throw new Error(`Expected 10 queued players, got ${ids.length}`);
	}

	const candidates = ids.map(id => {
		const lane = queue.Top.includes(id) ? 'Top' :
			queue.Jg.includes(id) ? 'Jungle' :
			queue.Mid.includes(id) ? 'Mid' :
			queue.Adc.includes(id) ? 'ADC' :
			queue.Supp.includes(id) ? 'Support' : 'Unknown';
		const m = guild.members.cache.get(id);
		const label = m?.displayName || m?.user?.username || id.slice(0, 10);
		return { id, lane, label: label.length > 28 ? label.slice(0, 28) : label };
	});

	const votes = {};

	const endAt = Date.now() + durationMs;
	let message = await textChannel.send({
		embeds: [buildVoteEmbed(candidates, votes, endAt)],
		components: [openPanelButton()]
	});

	const collector = message.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: durationMs
	});

	collector.on('collect', async (i) => {
		if (!ids.includes(i.user.id)) {
			await i.reply({ content: '❌ Only queued players can vote.', ephemeral: true });
			return;
		}

		const voterId = i.user.id;
		if (!votes[voterId]) votes[voterId] = [];
		await i.update({
			embeds: [buildVoteEmbed(candidates, votes, endAt)]
		});

		const picks = votes[voterId];
		const panel = await i.followUp({
			content: `Your current votes: ${picks.map(id => `<@${id}>`).join(', ') || 'none'}`,
			components: buildVoteButtons(candidates, picks),
			ephemeral: true,
			fetchReply: true
		});

		const userCollector = panel.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: Math.max(0, endAt - Date.now()),
			filter: ii => ii.user.id === voterId
		});

		userCollector.on('collect', async (ii) => {
			const [, candidateId] = ii.customId.split(':');

			const picks = votes[voterId];
			const idx = picks.indexOf(candidateId);
			if (idx >= 0) picks.splice(idx, 1);
			else {
				if (picks.length >= 2) {
					await ii.reply({ content: '⚠️ You already selected 2 captains. Unselect one first.', ephemeral: true });
					return;
				}
				picks.push(candidateId);
			}
			await ii.update({
				content: `Your current votes: ${picks.map(id => `<@${id}>`).join(', ') || 'none'}`,
				components: buildVoteButtons(candidates, picks)
			});

			await message.edit({
				embeds: [buildVoteEmbed(candidates, votes, endAt)]
			});
		});
	});


	return await new Promise((resolve) => {
		collector.on('end', async () => {
			const tally = new Map(candidates.map(c => [c.id, 0]));
			for (const arr of Object.values(votes)) {
				for (const cid of arr) {
					if (tally.has(cid)) tally.set(cid, tally.get(cid) + 1);
				}
			}

			const sorted = [...tally.entries()].sort((a, b) => {
				if (b[1] !== a[1]) return b[1] - a[1];
				return a[0].localeCompare(b[0]);
			});

			const top2 = sorted.slice(0, 2).map(([cid]) => cid);

			const finalEmbed = new EmbedBuilder()
				.setTitle('🏆 Captains Selected')
				.setDescription(
					`**Captain 1:** <@${top2[0]}>\n**Captain 2:** <@${top2[1]}>\n\n` +
					`Thanks for voting!`
				)
				.setColor(0x00b894);

			await message.edit({ embeds: [finalEmbed], components: [] });

			resolve(top2);
		});
	});
}

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
	startCaptainVote
};