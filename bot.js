const roster = require("./google-verifier");
require('dotenv').config();
const Discord = require('discord.js');
const { curly } = require('node-libcurl');
const YAML = require("yamljs");
const request = require("request-promise");
const express = require("express");
const bodyParser = require("body-parser");
const uuidv1 = require("uuid");
const os = require("os");
const fs = require("fs");
const path = require("path");
const process = require("process");


const bot = new Discord.Client();
const expressApp = express();
expressApp.use(bodyParser.json());


const TOKEN = process.env.BOT_TOKEN;
let streamURL = process.env.STREAMURL;
let newUserArray = {};
let verifiedMembers = {};
let newUsers = {};
let prospectiveMembers;
let isOnline = false;

const defaultConfig = {
    listenPort: 10001,
    callbackURL: "/callback",
    discord: {
        username: "my-bot",
        token: "",
        guild: "0",
        channel: "0"
    },
    groupme: {
        name: "",
        botId: "",
        accessToken: ""
    }
};

let config;
let tempDir = path.join(os.tmpdir(), "groupme-discord-bridge");
try {
    fs.mkdirSync(tempDir);
} catch(e) {
    // Already exists
}
try {
    config = YAML.load("bridgeBot.yml");
} catch(e) {
    console.error("Could not load bridgeBot.yml, perhaps it doesn't exist? Creating it...");
    fs.writeFileSync("bridgeBot.yml", YAML.stringify(defaultConfig, 4));
    console.error("Configuration file created. Please fill out the fields and then run the bot again.")
    process.exit(1);
}


bot.on('ready', async () => {
    console.info(`Logged in as ${bot.user.tag}!`);
    await bot.user.setActivity("Wiley Radio is currently offline");

    await updateStatus();
    await loadFiles();
    discordGuild = bot.guilds.cache.get(config.discord.guild);
    discordChannel = discordGuild.channels.cache.get(config.discord.channel);
})

bot.on("guildMemberAdd", (member) => {
    newUsers.newUser.push(member.id, member.user);
    member.roles.add('756314502273695766')
    storeNewUsers();
})
bot.on("guildMemberRemove", (member) => {
    if(newUsers.newUser.includes(member.id)) newUsers = arrayObjectRemove(newUsers.newUser, 'UID', member.id);

});

bot.on('message', async message  => {
    if (message.author.bot) return;
    const guild = message.guild;


    if(message.channel.id === config.discord.channel) {
        let author = message.member.nickname == null ? message.author.username : message.member.nickname;

        if(message.attachments.size > 0) {
            // First download the image
            let attachment = message.attachments.values().next().value;
            download(attachment.url, attachment.filename, (mimetype, downloadedLocation) => {
                let options = {
                    method: 'POST',
                    url: "https://image.groupme.com/pictures",
                    headers: {
                        "X-Access-Token": config.groupme.accessToken
                    },
                    formData: {
                        file: fs.createReadStream(downloadedLocation)
                    }
                };
                let req = request(options).then((res) => {
                    sendGroupMeMessage(author + " sent an image:", [ { type: "image", url: JSON.parse(res).payload.url } ], (response) => {
                        console.log(response);
                    });
                }).catch((err) => {
                    console.error(err);
                });
            });
        } else {
            sendGroupMeMessage(author + ": " + message.cleanContent, null, () => {});
        }
    }


    if (message.content.substr(0,7) === "!remove") {
        let rMember =  message.guild.member(message.mentions.users.first() || message.guild.members.cache.get(args[0])); //Gets the user
        newUsers.newUser.push(rMember.id, rMember.user);
        await rMember.roles.set(['756314502273695766'], "Removed Member from the club so reset roles.")
        let msg = await removeMember(rMember);
        await message.reply(msg);
        storeNewUsers();
    }

    if (message.content === '!verify' && message.member.roles.cache.has('756314502273695766')) {
        const UID = message.author.username + "-verification";
        if (message.channel.id === '756328190347182191') {
            let newUser = {};
            newUser.authorID = message.author.id;
            message.reply("Creating verification channel, please standby.").then(msg => {
                msg.delete({ timeout: 5000})
            })
            await guild.channels.create(UID, {
                type: 'text',
            }).then(async channel => {
                await channel.setParent('756321967879094322')
                await channel.updateOverwrite(message.author.id, {"VIEW_CHANNEL":true, "SEND_MESSAGES":true})
                newUser.UIDchannel = channel.id;
            })
            await message.channel.updateOverwrite(message.author.id, {VIEW_CHANNEL:false})
            newUser.step = 1;
            newUserArray.nonMembers.push(newUser);
            await roster.pullFromSheet();
            prospectiveMembers = await roster.getMembers();
            bot.channels.cache.get(newUser.UIDchannel).send(`<@${message.author.id}> Welcome to Wiley Radio! The verification process is pretty quick- I only have two questions for you.`);
            bot.channels.cache.get(newUser.UIDchannel).send(`1. What is your purdue email.`);

            await storeNonMembers();
            await message.delete({timeout: 5000})
        }
        else if (message.channel.id !== '756328190347182191'){
            message.reply("I can't do that in this channel - try in <#756328190347182191>").then(msg => {
                msg.delete({ timeout: 10000});
            })
        }
        else if (!message.member.roles.cache.has('756314502273695766')) {
            message.reply("You have already verified").then(msg => {
                msg.delete({timeout: 10000});
            })
        }
    }


    if (message.content !== '!verify' && message.channel.id === '756328190347182191') {
        await message.delete();
    }


    if (newUserArray.nonMembers.some(e => e.UIDchannel === message.channel.id)) {

        let index = await getIndex(message.channel.id);
        let usr = newUserArray.nonMembers[index];
        if (message.content === "<@&751857955661545592>") {
            await message.reply("Looks like you've requested manual assistance. I'll let an Exec take over.")
            let output = `Here's the info I have collected so far.\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}`;
            await bot.channels.cache.get(usr.UIDchannel).send(output);
            usr.step = 4;
            await storeNonMembers();
        } else if (usr.step === 3) {
            if (prospectiveMembers === undefined) {
                await roster.pullFromSheet();
                prospectiveMembers = await roster.getMembers();
            }
            if (message.member.roles.cache.has('751857955661545592') && message.content === '!verified') {
                await bot.channels.cache.get(usr.UIDchannel).send(`Got it! Verifying user and applying ranks now.`);
                usr.step = 5;

                await usr.member.roles.add('751857955661545592')
                await usr.member.roles.remove('756314502273695766')
                for (let i=0;i<usr.Roles.length;i++) {
                    await usr.member.setNickname(usr.Name)
                    let role = message.guild.roles.cache.find(role => role.name === usr.Roles[i]);
                    await usr.member.roles.add(role.id);
                }
                if (usr.hasShow === "TRUE") {
                    await usr.member.roles.add('751858085882232964')
                }
                await bot.channels.cache.get('756932892193456240').send(`<@${message.author.id}> manually verified <@${usr.UID}> as an Exec.\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}\n**User has Show**: ${usr.hasShow}`)
                await message.guild.channels.cache.get(usr.UIDchannel).delete();
                await verifyMember(usr);
            }
        } else if (usr.step === 4) {
            if (prospectiveMembers === undefined) {
                await roster.pullFromSheet();
                prospectiveMembers = await roster.getMembers();
            }
            if (message.member.roles.cache.has('751857955661545592') && message.content.substr(0,8) === '!setuser') {
                let email = message.content.substr(9)
                for (let i = 0; i < prospectiveMembers.length; i++) {
                    let pMember = prospectiveMembers[i];
                    if (pMember.Email === email) {
                        usr.step = 5;
                        usr.Phone = pMember.Phone;
                        usr.Status = pMember.Status
                        usr.Roles = pMember.Roles
                        usr.Name = pMember.Name
                        usr.hasShow = pMember.hasShow;
                        await usr.member.setNickname(usr.Name)
                        if (usr.Status === "Exec") {
                            await usr.member.roles.add('751857955661545592')
                        } else if (usr.Status === "Member")  {
                            await usr.member.roles.add('756314927945351209')
                        }
                        await usr.member.roles.remove('756314502273695766')
                        for (let i=0;i<usr.Roles.length;i++) {
                            let role = message.guild.roles.cache.find(role => role.name === usr.Roles[i]);
                            if (role !== undefined) {
                                await usr.member.roles.add(role.id);
                            }
                        }
                        if (usr.hasShow === "TRUE") {
                            await usr.member.roles.add('751858085882232964')
                        }
                        await bot.channels.cache.get('756932892193456240').send(`<@${message.author.id}> manually verified ${usr.Status} <@${usr.UID}> .\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}\n**User has Show**: ${usr.hasShow}`)
                        await message.guild.channels.cache.get(usr.UIDchannel).delete();
                        await verifyMember(usr);
                    }
                }
            } else await message.reply("I couldn't find a member with that email.")
        } else {
            if (usr.step === 2) {
                if (prospectiveMembers === undefined) {
                    await roster.pullFromSheet();
                    prospectiveMembers = await roster.getMembers();
                }
                for (let i = 0; i < prospectiveMembers.length; i++) {
                    let pMember = prospectiveMembers[i];
                    if (pMember.Phone.includes(message.content)) {
                        if (usr.Email !== pMember.Email) {
                            await bot.channels.cache.get(usr.UIDchannel).send(`That information doesn't quite match what I have on file let me get an <@&751857955661545592> to assist`)
                            await bot.channels.cache.get(usr.UIDchannel).send(`Here's the information I have gathered-\n**Email:** ${usr.Email}\n**Phone:** ${message.content}`)
                            usr.member = message.member;
                            usr.step = 4
                            await storeNonMembers();
                        }
                        else if (usr.Email === pMember.Email) {
                            usr.Phone = message.content;
                            usr.Status = pMember.Status
                            usr.Roles = pMember.Roles
                            if (usr.Status.includes("Exec")) {
                                usr.step = 3;
                                usr.member = message.member;
                                usr.Name = pMember.Name
                                usr.hasShow = pMember.hasShow;
                                await message.reply("Looks like you might be an exec - let me get an <@&751857955661545592> to manually verify")
                                await bot.channels.cache.get(usr.UIDchannel).send(`Here's the information I have gathered-\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}`);
                                await storeNonMembers();
                            } else {
                                usr.Name = pMember.Name
                                usr.step = 5;
                                usr.hasShow = pMember.hasShow;
                                await message.member.roles.add('756314927945351209')
                                await message.member.roles.remove('756314502273695766')
                                await message.member.setNickname(usr.Name)
                                for (let i = 0; i < usr.Roles.length; i++) {
                                    let role = message.guild.roles.cache.find(role => role.name === usr.Roles[i]);
                                    if (role !== undefined) {
                                        await message.member.roles.add(role.id);
                                    }
                                }
                                if (usr.hasShow === "TRUE") {
                                    await message.member.roles.add('751858085882232964')
                                }
                                await bot.channels.cache.get('756932892193456240').send(`I automatically verified <@${usr.UID}>.\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}\n**User has Show:** ${usr.hasShow}`)
                                await message.guild.channels.cache.get(usr.UIDchannel).delete();
                                await verifyMember(usr);
                            }
                        }
                    }
                }
                if (usr.Phone === undefined && usr.step !== 4) {
                    await message.reply(`I couldn't find a member with the phone number ${message.content}. Please re-enter your phone number or ping and @Exec for assistance.`);
                }
            }
            if (newUserArray.nonMembers[index].step === 1) {
                if (prospectiveMembers === undefined) {
                    await roster.pullFromSheet();
                    prospectiveMembers = await roster.getMembers();
                }
                for (let i = 0; i < prospectiveMembers.length; i++) {
                    let pMember = prospectiveMembers[i];
                    if (pMember.Email.includes(message.content)) {
                        usr.Email = pMember.Email;
                        usr.UID = message.author.id;
                        usr.step = 2;
                        if (pMember.Phone === '') {
                            usr.member = message.member;
                            usr.step = 4
                            await message.reply("I found an email that matches but I don't have a phone number on file to verify your identity. Hold on while I grab an <@&751857955661545592> to manually verify your account.");
                        } else await message.reply("First Step done, now: What is your Phone Number? (formatted like this 7654948221)");
                        await storeNonMembers();
                    }
                }
                if (usr.Email === undefined) {
                    await message.reply("I didn't quite understand that, make sure email is formatted 'user@email.com' or ping an @Exec for assistance")
                }
            }
        }
    }
    if (message.content === "!members" && message.member.roles.cache.has('751857955661545592')) {
        let counter = 0;
        if (verifiedMembers.members.length > 0) {
            let output = '';
            await message.reply("Here are the current Members I have verified-");
            for (let i = 0;i<verifiedMembers.members.length;i++) {
                counter++;
                if (counter < 10) {
                    output = output + `\n ${verifiedMembers.members[i].Name}`
                }
                if (counter === 10) {
                    counter = 0;
                    await bot.channels.cache.get(message.channel.id).send(output)
                }
            }
            if (counter !== 0 || counter !== 10) {
                await bot.channels.cache.get(message.channel.id).send(output)
            }
        } else await message.reply("I couldn't find any verified members.")
    }
})

expressApp.post(config.callbackURL, (req, res) => {
    if(req.body.name === config.groupme.name) return;

    let text = req.body.text;
    let sender = req.body.name;
    let attachments = req.body.attachments;

    if (attachments.length > 0) {
        let image = false;
        switch (attachments[0].type) {
            case "image":
                image = true;
            case "video":
                let array = attachments[0].url.split(".");
                let filename = uuidv1() + "." + array[array.length - 2];
                download(attachments[0].url, uuidv1(), (mimetype, downloadedLocation) => {
                    fs.stat(downloadedLocation, (err, stats) => {
                        if (err) {
                            console.error(err);
                            return;
                        }

                        // Discord does not allow files greater than 8MB unless user has Nitro
                        if (stats.size > (1024 * 1024 * 8)) {
                            discordChannel.send("**" + sender + "** ***Sent " + (image ? "an image" : "a video") + ":*** " + attachments[0].url).then(() => fs.unlink(downloadedLocation));
                        } else {
                            discordChannel.send("**" + sender + "**: " + text).then(() => {
                                discordChannel.send("**" + sender + "** ***Sent " + (image ? "an image" : "a video") + ":***", new Discord.Attachment(downloadedLocation, filename)).then(() => fs.unlink(downloadedLocation));
                            });
                        }
                    });
                });
                break;
            default:
                console.log("Unknown attachment: " + attachments[0].type);
        }
    } else {
        discordChannel.send("**" + sender + "**: " + text);
    }
});


//expressApp.listen(config.listenPort, () => console.log('Express now listening for requests'));
bot.login(TOKEN);

function arrayRemove(arr, value) { return arr.filter(function(ele){ return ele != value; });}

function arrayObjectRemove(arr, attr, value) {
    let i = arr.length;
    while(i--){
        if( arr[i] && arr[i].hasOwnProperty(attr) && (arguments.length > 2 && arr[i][attr] === value ) ){
            arr.splice(i,1);
        }
    }
}

async function removeMember(member) {
    for (let i=0;i<verifiedMembers.members.length;i++) {
        if (verifiedMembers.members[i].UID === member.id) {
            let id = verifiedMembers.members[i].UID;
            await arrayObjectRemove(verifiedMembers.members, 'UID', member.id);
            console.log(verifiedMembers)
            await storeMembers();
            return (`Removed <@${id}> from my member list`);
        }
    }
    return (`That person isn't a member.`)
}
async function getIndex(id) {
    for (let i=0; i < newUserArray.nonMembers.length; i++) {
        if (newUserArray.nonMembers[i].UIDchannel === id) {
            return i;
        } else return false;
    }
}
async function verifyMember(usr) {
    let verifiedMember = {};
    verifiedMember.Name = usr.Name;
    verifiedMember.Status = usr.Status;
    verifiedMember.Roles = usr.Roles;
    verifiedMember.Email = usr.Email;
    verifiedMember.Phone = usr.Phone;
    verifiedMember.hasShow = usr.hasShow;
    verifiedMember.UID = usr.UID;
    verifiedMember.step = usr.step;
    verifiedMembers.members.push(verifiedMember);
    await arrayObjectRemove(newUserArray.nonMembers, 'UID', usr.UID)
    await storeNonMembers();
    await storeMembers();
}
async function getStreamTitle(){
    let user;
    try {
        user = await curly.get('https://wileyradio.org/user.php',{'SSL_VERIFYPEER': false, 'FOLLOWLOCATION': true})
    } catch(e) {
        console.log("Couldn't connect to Wiley host:")
        console.error(e);
        return ("Wiley Radio is Offline")
    }
    user = user.data
    isOnline = true;
    if (user === 'DJ Roomba') {
        let song = await curly.get('https://wileyradio.org/title.php',{'SSL_VERIFYPEER': false, 'FOLLOWLOCATION': true})
        song = song.data
        let status = user + ' | ' + song
        isOnline = true;
        return (status);
    }
    else {
        return(user);
    }
}
let nowOnline = false;
async function updateStatus() {
    await bot.user.setActivity(await getStreamTitle());
    setTimeout(updateStatus, 5000);
    if (!isOnline && nowOnline) {
        const channel = bot.channels.cache.get(process.env.RADIO_CHANNEL);
        try {
            channel.leave();
        } catch(e) {
            console.error(e);
        }
        nowOnline = false;
    }
    if (isOnline && !nowOnline) {
        nowOnline = true;
        const channel = bot.channels.cache.get(process.env.RADIO_CHANNEL);
        try {
            channel.join().then(connection => {
                connection.play(streamURL, { volume: 0.3 });
            })
        } catch (e) {
            console.error(e)
        }
    }
}

async function loadFiles() {
    let data = await fs.readFileSync("verifiedMembers.json");
    verifiedMembers = JSON.parse(data)
    data = await fs.readFileSync("nonMembers.json");
    newUserArray = JSON.parse(data);
    data = await fs.readFileSync("newUsers.json");
    newUsers = JSON.parse(data);
}

async function storeMembers() {
    fs.writeFileSync("verifiedMembers.json", JSON.stringify(verifiedMembers, null, 4));
}

async function storeNewUsers() {
    fs.writeFileSync("newUsers.json", JSON.stringify(newUsers, null, 4));
}

async function storeNonMembers() {
    fs.writeFileSync("nonMembers.json", JSON.stringify(newUserArray, null, 4));
}

function download(url, filename, callback) {
    request.head(url, (err, res, body) => {
        let downloadedLocation = path.join(tempDir, filename)
        let contentType = res.headers['content-type'];

        request(url).pipe(fs.createWriteStream(downloadedLocation)).on('close', () => callback(contentType, downloadedLocation));
    });
}

function sendGroupMeMessage(message, attachments, callback) {
    return;
    let options = {
        method: 'POST',
        uri: 'https://api.groupme.com/v3/bots/post',
        body: {
            bot_id: config.groupme.botId,
            text: message
        },
        json: true
    };

    if(attachments != null) {
        options.body.attachments = attachments;
    }

    request(options).then((res) => {
        callback(res);
    }).catch((err) => {
        console.error(err);
    });
}