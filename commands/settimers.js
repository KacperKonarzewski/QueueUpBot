const { PermissionsBitField, MessageFlags } = require('discord.js');
const Config = require('../models/Config');

module.exports = {
	name: 'settimers',
	description: 'Set timeouts: waiting for members & captains voting (in seconds)',
	options: [
		{
			name: 'wait_members',
			description: 'How long to wait for all players to join VC (seconds)',
			type: 4,
			required: false
		},
		{
			name: 'captains_vote',
			description: 'How long the captain vote lasts (seconds)',
			type: 4,
			required: false
		}
	],
	async execute(interaction) {
		if (
			!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) &&
			!interaction.member.roles.cache.has('1386385941278621894')
		) {
			return interaction.reply({ content: '❌ You must be an admin to use this command.', flags: MessageFlags.Ephemeral });
		}

		const waitSec = interaction.options.getInteger('wait_members');
		const voteSec = interaction.options.getInteger('captains_vote');

		if (waitSec == null && voteSec == null) {
			return interaction.reply({
				content: 'ℹ️ Provide at least one option: `wait_members` or `captains_vote` (in seconds).',
				flags: MessageFlags.Ephemeral
			});
		}

		const MIN_S = 10;
		const MAX_S = 24 * 60 * 60;

		if (waitSec != null && (waitSec < MIN_S || waitSec > MAX_S)) {
			return interaction.reply({
				content: `❌ \`wait_members\` must be between ${MIN_S}s and ${MAX_S}s.`,
				flags: MessageFlags.Ephemeral
			});
		}
		if (voteSec != null && (voteSec < MIN_S || voteSec > MAX_S)) {
			return interaction.reply({
				content: `❌ \`captains_vote\` must be between ${MIN_S}s and ${MAX_S}s.`,
				flags: MessageFlags.Ephemeral
			});
		}

		const update = {};
		if (waitSec != null) update.WaitForMembersTimeoutMs = waitSec * 1000;
		if (voteSec != null) update.CaptainsVoteTimeoutMs = voteSec * 1000;

		try {
			const config = await Config.findOneAndUpdate(
				{ serverID: interaction.guild.id },
				{ $set: update },
				{ upsert: true, new: true }
			);

			const parts = [];
			if (waitSec != null) parts.push(`Wait for members: **${waitSec}s**`);
			if (voteSec != null) parts.push(`Captains vote: **${voteSec}s**`);

			await interaction.reply({
				content: `✅ Timers updated.\n${parts.join('\n')}`,
				flags: MessageFlags.Ephemeral
			});

		} catch (err) {
			await interaction.reply({
				content: `❌ Failed to update timers: ${err?.message || 'Unknown error'}`,
				flags: MessageFlags.Ephemeral
			});
		}
	}
};
