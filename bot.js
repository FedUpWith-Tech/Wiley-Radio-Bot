require('dotenv').config();
const Discord = require('discord.js');
const bot = new Discord.Client();
const { curly } = require('node-libcurl');

const TOKEN = process.env.BOT_TOKEN;
let streamURL = process.env.STREAMURL;


async function getStreamTitle(){
    let user = await curly.get('https://wileyradio.org/user.php',{'SSL_VERIFYPEER': false, 'FOLLOWLOCATION': true})
    user = user.data
    if (user === 'DJ Roomba') {
        let song = await curly.get('https://wileyradio.org/title.php',{'SSL_VERIFYPEER': false, 'FOLLOWLOCATION': true})
        song = song.data
        let status = user + ' | ' + song
        return (status);
    }
    else {
        return(user);
    }
}

bot.on('ready', async () => {
    console.info(`Logged in as ${bot.user.tag}!`);
    await bot.user.setActivity("Wiley Radio");
    const channel = bot.channels.cache.get(process.env.RADIO_CHANNEL);
    channel.join().then(connection => {
        connection.play(streamURL, { volume: 0.3 });
    })
    async function updateStatus() {
        await bot.user.setActivity(await getStreamTitle());
        setTimeout(updateStatus, 5000);
    }
    await updateStatus();
})

bot.login(TOKEN);