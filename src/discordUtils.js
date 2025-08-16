const { ChannelType, PermissionsBitField } = require('discord.js');

const moveUserToChannel = async (member, channel) => {
	try {
		if (member && channel && channel.type === ChannelType.GuildVoice) {
			await member.voice.setChannel(channel);
		}
	} catch (err) {
		console.error(`Failed to move ${member.user.tag}:`, err);
	}
};

const createCategory = async(guild, name = 'Queue') => {
    let category = guild.channels.cache.find(
        c => c.name === name && c.type === ChannelType.GuildCategory
    );
    if (!category) {
        category = await guild.channels.create({
            name: name,
            type: ChannelType.GuildCategory,
            reason: 'Needed a category for the bot channels',
			permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    allow: [PermissionsBitField.Flags.ViewChannel],
                },
            ],
        });
    }
    return category;
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const moveCategoryToBottom = async (category) => {
    try {
        const maxPosition = category.guild.channels.cache
            .filter(c => c.type === 4)
            .reduce((max, c) => Math.max(max, c.position), 0);

        await category.setPosition(maxPosition + 1);
    } catch (err) {
        console.error(err);
    }
};

const createVoiceChannel = async (guild, category, name = 'New Voice Channel') => {
    try {
        const channel = await guild.channels.create({
            name: name,
            type: ChannelType.GuildVoice,
			parent: category.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel],
                },
            ],
        });
        return channel;
    } catch (err) {
        console.error(err);
    }
};

const createTextChannel = async (guild, category, name = 'new-text-channel') => {
    try {
        const channel = await guild.channels.create({
            name: name,
            type: ChannelType.GuildText,
			parent: category.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    allow: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
                },
            ],
        });
        return channel;
    } catch (err) {
        console.error(err);
    }
};

const deleteChannel = async (channel) => {
    try {
    	await channel.delete();
    } catch (err) {
        console.error(err);
    }
};

const isValidChannel = async (guild, channelId) => {
	try {
		const channel = await guild.channels.fetch(channelId);

		if (channel && channel.isTextBased()) {
			return true;
		}
		return false;
	} catch (err) {
		return false;
	}
};

module.exports = {
	isValidChannel,
	createVoiceChannel,
	deleteChannel,
	createTextChannel,
	moveUserToChannel,
	createCategory,
	moveCategoryToBottom,
	wait
};