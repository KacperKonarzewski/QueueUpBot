require('dotenv').config();
const { Client, Collection, GatewayIntentBits, MessageFlags  } = require('discord.js');
const mongoose = require('mongoose');
const { addPlayerIfNotExists } = require('./src/playerManager');
const { writeCustomQueue } = require('./src/customManager');
const { deployCommandsForGuild } = require('./deploy-commands');
const fs = require('fs');
const path = require('path');
const Config = require('./models/Config');
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

//------------------------------------------------------

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
	]
});

client.commands = new Collection();

for (const file of commandFiles) {
	const command = require(path.join(commandsPath, file));
	client.commands.set(command.name, command);
}

//------------------------------------------------------

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
	.then(() => console.log("MongoDB connected"))
	.catch(err => console.log(err));

//------------------------------------------------------

client.on('guildCreate', async guild => {
	console.log(`Joined new server: ${guild.name} (${guild.id})`);
	await guild.members.fetch();
	guild.members.cache.forEach(member => {
		if (!member.user.bot) addPlayerIfNotExists(member);
	});

	let config = await Config.findOne({ serverID: guild.id });
	if (!config) {
		config = await Config.create({ serverID: guild.id });
	}

	const defaultChannel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(guild.members.me).has('SendMessages'));
	if (defaultChannel) {
		try {
			await deployCommandsForGuild(guild.id);
			await defaultChannel.send("Hello! I'm QueueUpBot. Use /setchannel to set the bot channel and /setvc to set the voice channel and then use /start to create a custom queue.");
		} catch (err) {
			await defaultChannel.send("❌ An error occurred while setting up the bot. Please try again later.");
		}
	}
});

client.once('ready', async () => {
	console.log(`Logged in as ${client.user.tag}`);

	client.guilds.cache.forEach(async guild => {
		await guild.members.fetch();
		guild.members.cache.forEach(member => {
			if (!member.user.bot) addPlayerIfNotExists(member);
		});
		const config = await Config.findOne({ serverID: guild.id });
		if (!config) {
			console.log(`No config found for guild ${guild.id}, creating default config.`);
			await Config.create({ serverID: guild.id });
		}
		try {
			await deployCommandsForGuild(guild.id);
			const botChannel = guild.channels.cache.get(config.botChannel);
			const voiceChannel = guild.channels.cache.get(config.botVCchannel);
			if (!botChannel || !voiceChannel) {
				throw new Error(`Bot channel or voice channel not set for guild ${guild.id}.`);
			}
			await writeCustomQueue(botChannel);
		}
		catch (err) {
			const defaultChannel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(guild.members.me).has('SendMessages'));
			if (defaultChannel) {
				await defaultChannel.send("❌ Please set up the bot channel and voice channel by using commands /setchannel and /setvc.");
			}
			console.error(`Error writing custom queue for guild ${guild.id}:`, err);
		}
	});
});


client.on('interactionCreate', async interaction => {
	if (!interaction.isCommand()) return;
	const command = client.commands.get(interaction.commandName);
	if (!command) return;

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
	}
});

client.on('guildMemberAdd', member => {
	if (!member.user.bot) addPlayerIfNotExists(member);
});

//------------------------------------------------------

client.login(process.env.DISCORD_TOKEN);
