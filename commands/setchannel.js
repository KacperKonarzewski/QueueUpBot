const { ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const Config = require('../models/Config');
const { isValidChannel } = require('../src/discordUtils');

module.exports = {
	name: 'setchannel',
	description: 'Set the bot channel for this server',
	options: [
		{
			name: 'channel',
			description: 'The channel where the bot should operate',
			type: 7,
			required: true
		}
	],
	async execute(interaction) {
		const channel = interaction.options.getChannel('channel');

		//--------------------------------------------

		if (!channel || !(await isValidChannel(interaction.guild, channel.id))) {
			return interaction.reply({ content: '❌ That channel does not exist or is not accessible to me.', flags: MessageFlags.Ephemeral });
		}
		if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) && !interaction.member.roles.cache.has("1386385941278621894")) {
			return interaction.reply({ content: '❌ You must be an admin/mod to use this command.', flags: MessageFlags.Ephemeral });
		}
		if (channel.type !== ChannelType.GuildText) {
			return interaction.reply({ content: '❌ You must select a text channel.', flags: MessageFlags.Ephemeral });
		}

		//--------------------------------------------

		await Config.findOneAndUpdate(
			{ serverID: interaction.guild.id },
			{ botChannel: channel.id },
			{ upsert: true, new: true }
		);

		//--------------------------------------------
		
		await interaction.reply(`✅ Bot channel set to ${channel}`);
	}
};
