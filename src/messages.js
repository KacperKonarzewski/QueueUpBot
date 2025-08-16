const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
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
	generateWaitEmbed
};