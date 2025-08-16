const { ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const Config = require('../models/Config');
const { isValidChannel } = require('../src/discordUtils');
const { writeCustomQueue } = require('../src/customManager');

module.exports = {
	name: 'setvc',
	description: 'Set the bot voice channel for this server',
	options: [
		{
			name: 'voice_channel',
			description: 'The voice channel where the bot should operate',
			type: 7,
			required: true
		}
	],
	async execute(interaction) {
		const channel = interaction.options.getChannel('voice_channel');

		//--------------------------------------------

		if (!channel || !(await isValidChannel(interaction.guild, channel.id))) {
			return interaction.reply({ content: '❌ That channel does not exist or is not accessible to me.', flags: MessageFlags.Ephemeral });
		}
		if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
			return interaction.reply({ content: '❌ You must be an admin to use this command.', flags: MessageFlags.Ephemeral });
		}
		if (channel.type !== ChannelType.GuildVoice) {
			return interaction.reply({ content: '❌ You must select a voice channel.', flags: MessageFlags.Ephemeral });
		}

		//--------------------------------------------

		await Config.findOneAndUpdate(
			{ serverID: interaction.guild.id },
			{ botVCchannel: channel.id },
			{ upsert: true, new: true }
		);

		//--------------------------------------------
		
		await interaction.reply(`✅ Bot voice channel set to ${channel}`);
	}
};
