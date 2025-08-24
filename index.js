require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { connectToDb } = require('./db');
const { addPlayerIfNotExists } = require('./src/playerManager');
const { writeCustomQueue, bumpQueueMessage } = require('./src/customManager');
const { deployCommandsForGuild } = require('./deploy-commands');
const Config = require('./models/Config');

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
	],
});

client.commands = new Collection();
for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'))) {
	const command = require(path.join(__dirname, 'commands', file));
	client.commands.set(command.name, command);
}

const findDefaultTextChannel = (guild) =>
	guild.channels.cache.find(
		(c) =>
			c.type === ChannelType.GuildText &&
			c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
	);

client.on('guildCreate', async (guild) => {
	console.log(`Joined new server: ${guild.name} (${guild.id})`);
	await guild.members.fetch().catch(() => { });
	for (const m of guild.members.cache.values()) if (!m.user.bot) addPlayerIfNotExists(m);

	let config = await Config.findOne({ serverID: guild.id });
	if (!config) config = await Config.create({ serverID: guild.id });

	const defaultChannel = findDefaultTextChannel(guild);
	if (defaultChannel) {
		try {
			await deployCommandsForGuild(guild.id);
			await defaultChannel.send(
				"Hello! I'm QueueUpBot. Use /setchannel to set the bot channel and /setvc to set the voice channel, then /start to create a custom queue."
			);
		} catch {
			await defaultChannel.send('❌ An error occurred while setting up the bot. Please try again later.');
		}
	}
});

client.on('messageCreate', async (msg) => {
	if (msg.author.bot) return;

	const config = await Config.findOne({ serverID: msg.guild.id }).catch(() => null);
	if (!config || !config.botChannel) return;

	if (msg.channel.id !== config.botChannel) return;

	const state = getGuildState(msg.guild.id);
	const queueNumber = config.QueueNumber ?? 1;
	const queue = state.queues.get(queueNumber);

	await bumpQueueMessage(msg.channel, config, queue, queueNumber);
});


client.once('ready', async () => {
	console.log(`Logged in as ${client.user.tag}`);

	for (const guild of client.guilds.cache.values()) {
		await guild.members.fetch().catch(() => { });
		for (const m of guild.members.cache.values()) if (!m.user.bot) addPlayerIfNotExists(m);

		let config = await Config.findOne({ serverID: guild.id });
		if (!config) config = await Config.create({ serverID: guild.id });

		try {
			await deployCommandsForGuild(guild.id);
			const botChannel = guild.channels.cache.get(config.botChannel);
			const voiceChannel = guild.channels.cache.get(config.botVCchannel);
			if (!botChannel || !voiceChannel) throw new Error('Bot channel or voice channel not set.');
			await writeCustomQueue(botChannel);
		} catch (err) {
			const defaultChannel = findDefaultTextChannel(guild);
			if (defaultChannel) {
				await defaultChannel.send('❌ Please set up the bot channel and voice channel using /setchannel and /setvc.');
			}
			console.error(`Error writing custom queue for guild ${guild.id}:`, err.message || err);
		}
	}
});

client.on('interactionCreate', async (interaction) => {
	if (!interaction.isChatInputCommand?.()) return;
	const command = client.commands.get(interaction.commandName);
	if (!command) return;
	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		try {
			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({ content: 'There was an error while executing this command.' });
			} else {
				await interaction.reply({ content: 'There was an error while executing this command.', ephemeral: true });
			}
		} catch { }
	}
});

client.on('guildMemberAdd', (member) => {
	if (!member.user.bot) addPlayerIfNotExists(member);
});

(async () => {
	try {
		await connectToDb();
		await client.login(process.env.DISCORD_TOKEN);
	} catch (err) {
		console.error('❌ Fatal startup error:', err);
		process.exit(1);
	}
})();
