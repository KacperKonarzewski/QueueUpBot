const { ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const Config = require('../models/Config');
const { writeCustomQueue } = require('../src/customManager');

module.exports = {
	name: 'start',
	description: 'Start the bot for this server',
	async execute(interaction) {
		//--------------------------------------------

	
		if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) && !interaction.member.roles.cache.has("1386385941278621894")) {
			return interaction.reply({ content: '❌ You must be an admin to use this command.', flags: MessageFlags.Ephemeral });
		}

		const guild = interaction.guild;
		
		//---------------------------------------------

		const config = await Config.findOne({ serverID: guild.id });
		try {
			const botChannel = guild.channels.cache.get(config.botChannel);
			const voiceChannel = guild.channels.cache.get(config.botVCchannel);
			if (!botChannel || !voiceChannel) {
				throw new Error(`Bot channel or voice channel not set for guild ${guild.id}.`);
			}
			await interaction.reply(`✅ Bot started.`);
			await writeCustomQueue(botChannel);
		}
		catch (err) {
			await interaction.reply(`❌ Please set up the bot channel and voice channel by using commands /setchannel and /setvc.`);
			console.error(`Error writing custom queue for guild ${guild.id}:`, err);
		}
		
	}
};
