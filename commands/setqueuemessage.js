const { PermissionsBitField, MessageFlags } = require('discord.js');
const Config = require('../models/Config');
const { writeCustomQueue } = require('../src/customManager');

module.exports = {
	name: 'setqueueheader',
	description: 'Set the header text for the custom queue',
	options: [
		{
			name: 'header',
			description: 'The new header text for the queue',
			type: 3,
			required: true
		}
	],
	async execute(interaction) {
		const newHeader = interaction.options.getString('header');
		//--------------------------------------------

		if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
			return interaction.reply({ content: '❌ You must be an admin to use this command.', flags: MessageFlags.Ephemeral });
		}

		//--------------------------------------------
		const config = await Config.findOneAndUpdate(
			{ serverID: interaction.guild.id },
			{ queueHeader: newHeader },
			{ upsert: true, new: true }
		);
		//--------------------------------------------
		await interaction.reply({ content: `✅ Queue header updated to:\n${newHeader}`, flags: MessageFlags.Ephemeral });
		
		if (config.botChannel) {
			const channel = interaction.guild.channels.cache.get(config.botChannel);
			if (channel) {
				writeCustomQueue(channel).catch(err => {
					console.error(`Error updating custom queue in channel ${channel.id}:`, err);
					interaction.followUp({ content: '❌ There was an error updating the queue message.', flags: MessageFlags.Ephemeral });
				});
			}
		}
		//--------------------------------------------
	}
};
