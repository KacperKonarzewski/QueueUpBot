const { generateWaitEmbed } = require('./messages');

const fakeGuild = {
	members: {
		cache: new Map([
			['user1', { id: 'user1', voice: { channelId: null }, user: { tag: 'User1' } }],
			['user2', { id: 'user2', voice: { channelId: null }, user: { tag: 'User2' } }],
			['279964394157244416', { id: '279964394157244416', voice: { channelId: null }, user: { tag: 'kacutoja' } }],
			])
		}
};

const waitForMembersInChannel = async (members, channels, timeout = 60000) => {
    return new Promise(async (resolve, reject) => {
        const start = Date.now();

		const statusMessage = await channels.text.send({
			embeds: [generateWaitEmbed(members, channels.voice, start, timeout)]
		});

		const interval = setInterval(async () => {
            const ready = members.filter(m => m.voice.channelId === channels.voice.id);
            const missing = members.filter(m => m.voice.channelId !== channels.voice.id);

           await statusMessage.edit({
				embeds: [generateWaitEmbed(members, channels.voice, start, timeout)]
			});

            if (ready.length === members.length) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - start > timeout) {
                clearInterval(interval);
                reject(
                    new Error(
                        `❌ Not all members joined the voice channel in time: ${missing
                            .map(m => m.user.tag)
                            .join(', ')}`
                    )
                );
            }
        }, 1000);
    });
};

const draftStart = async (queue, config, channels, guild) => {
	fakeGuild.members.cache.get('user1').voice.channelId = channels.voice.id;
	fakeGuild.members.cache.get('user2').voice.channelId = 'voiceChannelId';
	fakeGuild.members.cache.get('279964394157244416').voice.channelId = 'voiceChannelId';

	try {
		//const members = Object.values(queue).flat().map(id => guild.members.cache.get(id)).filter(Boolean);
		const members = Object.values(queue).flat().map(id => fakeGuild.members.cache.get(id)).filter(Boolean);				
		await waitForMembersInChannel(members, channels);
	}
	catch (err) {
		throw new Error(err.message);
	}
	

	//--------------------------------------------



	//(async () => {
	//	try {
	//		const links = await createDraftLinks();
	//		await sendDraftLinks(textChannel, links);
	//	} catch (err) {
	//		console.error(err);
	//	}
	//})();

	//await pickCapitans(queue, config);
}

module.exports = {
	draftStart
};