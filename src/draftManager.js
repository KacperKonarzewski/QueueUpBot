const { generateWaitEmbed, startCaptainVote, sendDraftLinks } = require('./messages');
const { createDraftLinks } = require('./draftlol');

const fakeGuild = {
	members: {
		cache: new Map([
			['user1', { id: 'user1', voice: { channelId: null }, user: { tag: 'User1' } }],
			['user2', { id: 'user2', voice: { channelId: null }, user: { tag: 'User2' } }],
			['user3', { id: 'user3', voice: { channelId: null }, user: { tag: 'User3' } }],
			['user4', { id: 'user4', voice: { channelId: null }, user: { tag: 'User4' } }],
			['user5', { id: 'user5', voice: { channelId: null }, user: { tag: 'User5' } }],
			['user6', { id: 'user6', voice: { channelId: null }, user: { tag: 'User6' } }],
			['user7', { id: 'user7', voice: { channelId: null }, user: { tag: 'User7' } }],
			['user8', { id: 'user8', voice: { channelId: null }, user: { tag: 'User8' } }],
			['user9', { id: 'user9', voice: { channelId: null }, user: { tag: 'User9' } }],
			['279964394157244416', { id: '279964394157244416', voice: { channelId: null }, user: { tag: 'kacutoja' } }],
		])
	}
};

const waitForMembersInChannel = async (members, channels, queueNumber, timeout = 60000) => {
    return new Promise(async (resolve, reject) => {
        const start = Date.now();

		const statusMessage = await channels['text' + queueNumber].send({
			embeds: [generateWaitEmbed(members, channels['voice' + queueNumber], start, timeout)]
		});

		const interval = setInterval(async () => {
            const ready = members.filter(m => m.voice.channelId === channels['voice' + queueNumber].id);
            const missing = members.filter(m => m.voice.channelId !== channels['voice' + queueNumber].id);

           await statusMessage.edit({
				embeds: [generateWaitEmbed(members, channels['voice' + queueNumber], start, timeout)]
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

const draftStart = async (queue, config, channels, guild, queueNumber) => {
	fakeGuild.members.cache.get('user1').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user2').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user3').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user4').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user5').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user6').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user7').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user8').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('user9').voice.channelId = channels['voice' + queueNumber].id;
	fakeGuild.members.cache.get('279964394157244416').voice.channelId = channels['voice' + queueNumber].id;

	try {
		//const members = Object.values(queue).flat().map(id => guild.members.cache.get(id)).filter(Boolean);
		const members = Object.values(queue).flat().map(id => fakeGuild.members.cache.get(id)).filter(Boolean);				
		await waitForMembersInChannel(members, channels, queueNumber);
		const captains = await startCaptainVote(channels['text' + queueNumber], guild, queue);
	}
	catch (err) {
		throw new Error(err.message);
	}
	

	//--------------------------------------------

	//(async () => {
	//		try {
	//			const links = await createDraftLinks();
	//			await sendDraftLinks(channels['text' + queueNumber], links);
	//		} catch (err) {
	//			console.error(err);
	//		}
	//	})();
	//await pickCapitans(queue, config);
}

module.exports = {
	draftStart
};