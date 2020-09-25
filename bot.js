// There are far too many imports here but deal with it. Might cut down on dependencies later
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


// Spawn new processes to be used later
const bot = new Discord.Client();
const expressApp = express();
expressApp.use(bodyParser.json());

// Define things to be used later
const TOKEN = process.env.BOT_TOKEN;        // Discord bot token
let streamURL = process.env.STREAMURL;      // Wiley Radio direct stream link
let newUserArray = {};                      // Not NewUserArray - this is a JSON object for in-progress memberships
let verifiedMembers = {};                   // JSON object containing all verified Members
let newUsers = {};                          // JSON object containing members who haven't started the verification process
let prospectiveMembers;                     // JSON object containing google sheets data - ignore the name
let isOnline = false;                       // Bool to handle stream being offline
let nowOnline = false;                      // Bool to handle the stream going offline
let config;                                 // JSON object containing discord<-->groupme bridge config
let tempDir = path.join(os.tmpdir(), "groupme-discord-bridge");     // Dir for storing images in transit between groupme and discord

// Default config for groupme<-->discord bridge. Needed if config fails to load
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

// Generate the temp dir for image caching
try {
    fs.mkdirSync(tempDir);
} catch(e) {
    // Already exists
}

// Try to load config for gorupme<-->discord bridge
try {
    config = YAML.load("bridgeBot.yml");
} catch(e) {
    // If no config exists or if it cannot load then reset to default.
    console.error("Could not load bridgeBot.yml, perhaps it doesn't exist? Creating it...");
    fs.writeFileSync("bridgeBot.yml", YAML.stringify(defaultConfig, 4));
    console.error("Configuration file created. Please fill out the fields and then run the bot again.")
    process.exit(1);
}

// Run these things on bot startup
bot.on('ready', async () => {
    console.info(`Logged in as ${bot.user.tag}!`);                      // Log successful startup
    await bot.user.setActivity("Wiley Radio is currently offline");       // Set default presence
    await updateStatus();                                                       // Update status and attempt to start radio stream
    await loadFiles();                                                          // Load stored JSON objects
    discordGuild = bot.guilds.cache.get(config.discord.guild);                  // Bad practice but it works
    discordChannel = discordGuild.channels.cache.get(config.discord.channel);   // Bad practice but it works
})

// Run these on new member joining the discord
bot.on("guildMemberAdd", (member) => {
    newUsers.newUser.push(member.id, member.user);          // Add user to newUser JSON object
    member.roles.add('756314502273695766');       // Give user prospectiveMember Roles
    storeNewUsers();                                        // Store newUser JSON object

    // TODO if user has previously verified they need to have their roles and such added
})

// Run these on member leaving the discord
bot.on("guildMemberRemove", (member) => {
    // If member is in newUser object remove them
    if(newUsers.newUser.includes(member.id)) newUsers = arrayObjectRemove(newUsers.newUser, 'UID', member.id);
    // TODO probably more things I need to handle when a member leaves
});

// Message handling- this is the primary runtime code
bot.on('message', async message  => {
    if (message.author.bot) return;     // Ignore bot users
    const guild = message.guild;        // Store the guild the message was sent in

    // This if handles messages sent in #general to go to groupme
    if(message.channel.id === config.discord.channel) {
        // Store author name
        let author = message.member.nickname == null ? message.author.username : message.member.nickname;
        // Handle discord messages with attachments
        if(message.attachments.size > 0) {
            // First download the image
            let attachment = message.attachments.values().next().value;
            download(attachment.url, attachment.filename, (mimetype, downloadedLocation) => {
                // Store header needed to post image
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
                // Now send message with attachments
                let req = request(options).then((res) => {
                    sendGroupMeMessage(author + " sent an image:", [ { type: "image", url: JSON.parse(res).payload.url } ], (response) => {
                        console.log(response);
                    });
                }).catch((err) => {
                    console.error(err);
                });
            });
        } else { // If no attachments just send message
            sendGroupMeMessage(author + ": " + message.cleanContent, null, () => {});
        }
    }

    // Handles removing members
    if (message.content.substr(0,7) === "!remove") {
        let rMember =  message.guild.member(message.mentions.users.first() || message.guild.members.cache.get(args[0]));        // Gets the user
        newUsers.newUser.push(rMember.id, rMember.user);        // Adds the user back to the new user array
        await rMember.roles.set(['756314502273695766'], "Removed Member from the club so reset roles.");        // Reset roles back to prospective member role
        let msg = await removeMember(rMember);      // Remove member and store feedback
        await message.reply(msg);       // Reply the feedback
        await storeNewUsers();      // Store new users
    }

    // Handles new user verification
    if (message.content === '!verify' && message.member.roles.cache.has('756314502273695766')) {
        // TODO I need to handle verifying if two discord accounts try to verify as the same person
        const UID = message.author.username + "-verification"; // Variable that stores unique user ID to be used when naming things
        // Only start verification process if the channel is correct
        if (message.channel.id === '756328190347182191') {
            let newUser = {};       // Create temp user Object
            newUser.authorID = message.author.id;       // Store discord ID
            // Reply to acknowledge user then clean up messages
            message.reply("Creating verification channel, please standby.").then(msg => {  msg.delete({ timeout: 5000})  });

            // Create user specific channel
            await guild.channels.create(UID, {
                type: 'text',
            }).then(async channel => {
                // After channel has been created then set it in the Verification category
                await channel.setParent('756321967879094322');
                // After channel has been moved allow user to see channel and send messages
                await channel.updateOverwrite(message.author.id, {"VIEW_CHANNEL":true, "SEND_MESSAGES":true});
                // Store channel ID in user Object for later
                newUser.UIDchannel = channel.id;
            })

            // Now that user has specific verification channel remove them from being able to see the verification channel
            await message.channel.updateOverwrite(message.author.id, {VIEW_CHANNEL:false})
            // Set user step to 1 to handle where the user is in the process
            newUser.step = 1;
            // Store temp user object to permanent newUserArray JSON object
            newUserArray.nonMembers.push(newUser);
            // Pull data from sheet to insure the internal member roster is up to date
            await roster.pullFromSheet();
            // Actually store the data here. Bad workaround but it does work
            prospectiveMembers = await roster.getMembers();
            // Send message to user to explain verification process
            bot.channels.cache.get(newUser.UIDchannel).send(`<@${message.author.id}> Welcome to Wiley Radio! The verification process is pretty quick- I only have two questions for you.`);
            // Send question 1
            bot.channels.cache.get(newUser.UIDchannel).send(`1. What is your purdue email.`);
            // Store NewUserArray JSON object so that if bot crashes during verification no data is lost
            await storeNonMembers();
            // Finally delete the initial user call of !verify
            await message.delete({timeout: 5000})
        }
        // If channel is incorrect alert user and delete messages after 5 seconds
        else if (message.channel.id !== '756328190347182191'){
            message.reply("I can't do that in this channel - try in <#756328190347182191>").then(msg => {
                msg.delete({ timeout: 5000});
            })
        }
        // If user is already a member don't let them verify then delete messages after 5 seconds
        else if (!message.member.roles.cache.has('756314502273695766')) {
            message.reply("You have already verified").then(msg => {
                msg.delete({timeout: 5000});
            })
        }
    }

    // If message sent in verification channel that is not "!verify" delete it
    if (message.content !== '!verify' && message.channel.id === '756328190347182191') {
        await message.delete();
    }

    // If the user has started the verification process this code takes over
    if (newUserArray.nonMembers.some(e => e.UIDchannel === message.channel.id)) {
        // Store the index of the user in the JSON object
        let index = await getIndex(message.channel.id);
        // Store user object as variable for use
        let usr = newUserArray.nonMembers[index];
        /**
         * This next part is the master switch controller for the verification process.
         * It isn't fully complete and I'm sure there are cases that aren't handled yet
         * but I think its ready for deployment. Will be making optimizations for this
         * section later. Once a user is verified the temp verification channel is
         * deleted, verification is logged, and all roles are applied to user
         *
         * case 1:
         * This case handles the first message which should be an email formatted like
         * email@purdue.edu if it isn't formatted like this it reprompts the user to
         * send their email. I need to add a case for multiple failures and automatic
         * handoff to an exec for manual verification but the user can do that now so
         * its fine. If a phone number cannot be found for the user is sends to case 3
         * for manual verification otherwise sends to case 2
         *
         * case 2:
         * This case handles the second message which should be a phone number formatted
         * like 7654948221 if it isn't in that format it reprompts the user for input.
         * If a user's phone doesn't match their email but does match another members it
         * stops and sends the info for an Exec to take over in case 3. If the information
         * matches and the user is not an exec it verifies the user and logs it, sends
         * to step 5. If the user is an exec it pings an exec for manual verification and
         * sends to step 4
         *
         * case 3:
         * This case handles the required manual verification of Execs. This is for OPsec
         * as the exec role is an administrator and can verify other users. It would be
         * a huge leak if a bad actor gets the exec role. An existing Exec must type
         * `!verified` after verifying user identity and the bot takes over and verifies
         * and applies all roles.
         *
         * case 4:
         * This case handles information mismatch or user-prompted manual verification.
         * To verify and exec has to type `!setuser email@purdue.edu` and the bot will
         * do the rest despite any other roles. This sends to step 5, if a email couldn't
         * be found for the user it re-prompts for email.
         */
        switch (usr.step) {
            // Handle step 1: user email
            case 1:
                // Handle user requested manual verification
                if (message.content === "<@&751857955661545592>") {
                    await message.reply("Looks like you've requested manual assistance. I'll let an Exec take over.")
                    let output = `Here's the info I have collected so far.\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}`;
                    await bot.channels.cache.get(usr.UIDchannel).send(output);
                    usr.step = 4;
                    await storeNonMembers();
                    break;
                }
                // Handle if bot crashed between previous step and now
                if (prospectiveMembers === undefined) {
                    await roster.pullFromSheet();
                    prospectiveMembers = await roster.getMembers();
                }

                // Loop through all members on the Roster
                for (let i = 0; i < prospectiveMembers.length; i++) {
                    // Store member object as variable to be used later
                    let pMember = prospectiveMembers[i];

                    // Handles if user email matches a roster member email
                    if (pMember.Email.includes(message.content)) {
                        usr.Email = pMember.Email;      // Store email to user object
                        usr.UID = message.author.id;    // Store Discord UID to user object
                        usr.step = 2;                   // Set step to 2

                        // If no phone record exists we can't verify so prompt exec for manual verification
                        if (pMember.Phone === '') {
                            usr.member = message.member;    // Store discord member object to usr object
                            usr.step = 4                    // Set step to 4
                            await message.reply("I found an email that matches but I don't have a phone number on file to verify your identity. Hold on while I grab an <@&751857955661545592> to manually verify your account.");
                        }
                        // If phone found, send user Question #2
                        else await message.reply("First Step done, now: What is your Phone Number? (formatted like this 7654948221)");
                        // Store newUserArray
                        await storeNonMembers();
                    }
                }
                // After loop, if no user email is stored then that means an email wasn't found. Reprompt for input
                if (usr.Email === undefined) {
                    await message.reply("I didn't quite understand that, make sure email is formatted 'user@email.com' or ping an @Exec for assistance")
                }
                break;

            // Handle step 2: user phone
            case 2:
                // Handle user requested manual verification
                if (message.content === "<@&751857955661545592>") {
                    await message.reply("Looks like you've requested manual assistance. I'll let an Exec take over.")
                    let output = `Here's the info I have collected so far.\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}`;
                    await bot.channels.cache.get(usr.UIDchannel).send(output);
                    usr.step = 4;
                    await storeNonMembers();
                    break;
                }
                // Handle if bot crashed between previous step and now
                if (prospectiveMembers === undefined) {
                    await roster.pullFromSheet();
                    prospectiveMembers = await roster.getMembers();
                }

                // Loop through all members on the Roster
                for (let i = 0; i < prospectiveMembers.length; i++) {
                    // Store member object as variable to be used later
                    let pMember = prospectiveMembers[i];

                    // Handles if phone matches roster member
                    if (pMember.Phone.includes(message.content)) {
                        // Handles if stored email from last step doesn't match phone number in roster
                        if (usr.Email !== pMember.Email) {
                            // Alert user of data mismatch and then send gathered data for Exec to manually verify
                            await bot.channels.cache.get(usr.UIDchannel).send(`That information doesn't quite match what I have on file let me get an <@&751857955661545592> to assist`);
                            await bot.channels.cache.get(usr.UIDchannel).send(`Here's the information I have gathered-\n**Email:** ${usr.Email}\n**Phone:** ${message.content}`);
                            usr.member = message.member;        // Store discord member object in user object
                            usr.step = 4;                       // Set step to 4
                            await storeNonMembers();            // Store newUserArray permanent JSON object
                        }
                        // Handles if both phone and email matches
                        else if (usr.Email === pMember.Email) {
                            usr.Phone = message.content;        // Store phone number to user object
                            usr.Status = pMember.Status         // Store user Rank to user object
                            usr.Roles = pMember.Roles           // Store club roles to user object

                            // If user is an exec we need to manually verify
                            if (usr.Status.includes("Exec")) {
                                usr.step = 3;                   // Set step to 3
                                usr.member = message.member;    // Store discord member object in user object
                                usr.Name = pMember.Name         // Store real name to user object
                                usr.hasShow = pMember.hasShow;  // Store if user has show
                                // Notify the user that manual verification is required and send gathered info to exec
                                await message.reply("Looks like you might be an exec - let me get an <@&751857955661545592> to manually verify")
                                await bot.channels.cache.get(usr.UIDchannel).send(`Here's the information I have gathered-\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}`);
                                // store newUserArray JSON object
                                await storeNonMembers();
                            } else { // Else if a user is not an exec and everything matches proceed to verify
                                usr.Name = pMember.Name;            // Store real name to usr object
                                usr.step = 5;                       // Set step to 5
                                usr.hasShow = pMember.hasShow;      // Store if user has show
                                await message.member.roles.add('756314927945351209');       // Add member role
                                await message.member.roles.remove('756314502273695766');    // Remove prospectivemember role
                                await message.member.setNickname(usr.Name);                           // Set nickname to real name

                                // Add roles to user
                                for (let i = 0; i < usr.Roles.length; i++) {
                                    // Find role object based on common name
                                    let role = message.guild.roles.cache.find(role => role.name === usr.Roles[i]);
                                    // If role object found apply role
                                    if (role !== undefined) {
                                        await message.member.roles.add(role.id);
                                    }
                                }

                                // If user has a show give them studio role
                                if (usr.hasShow === "TRUE") {
                                    await message.member.roles.add('751858085882232964')
                                }

                                // Log verification
                                await bot.channels.cache.get('756932892193456240').send(`I automatically verified <@${usr.UID}>.\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}\n**User has Show:** ${usr.hasShow}`)
                                // Delete user verification channel
                                await message.guild.channels.cache.get(usr.UIDchannel).delete();
                                // Finally, verify user
                                await verifyMember(usr);
                            }
                        }
                    }
                }
                // After loop, if no phone is defined that means a phone couldn't be found
                if (usr.Phone === undefined) {
                    await message.reply(`I couldn't find a member with the phone number ${message.content}. Please re-enter your phone number or ping an @Exec for assistance.`);
                }
                break;

            // Handle case 3: user is exec needing manual verification
            case 3:
                // Handle if bot crashed between previous step and now
                if (prospectiveMembers === undefined) {
                    await roster.pullFromSheet();
                    prospectiveMembers = await roster.getMembers();
                }
                // Handles manual verification by exec
                if (message.member.roles.cache.has('751857955661545592') && message.content === '!verified') {
                    // Notify users of success
                    await bot.channels.cache.get(usr.UIDchannel).send(`Got it! Verifying user and applying ranks now.`);
                    usr.step = 5;       // Set user step to 5
                    await usr.member.roles.add('751857955661545592');       // Add exec role
                    await usr.member.roles.remove('756314502273695766');    // Remove prospective member role
                    await usr.member.setNickname(usr.Name);                           // Set nickname to real name

                    // Add roles to user
                    for (let i = 0; i < usr.Roles.length; i++) {
                        // Find role object based on common name
                        let role = message.guild.roles.cache.find(role => role.name === usr.Roles[i]);
                        // If role object found apply role
                        if (role !== undefined) {
                            await message.member.roles.add(role.id);
                        }
                    }

                    // If user has show give them studio role
                    if (usr.hasShow === "TRUE") {
                        await usr.member.roles.add('751858085882232964')
                    }

                    // Log manual verification
                    await bot.channels.cache.get('756932892193456240').send(`<@${message.author.id}> manually verified <@${usr.UID}> as an Exec.\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}\n**User has Show**: ${usr.hasShow}`)
                    // Delete temp verification channel
                    await message.guild.channels.cache.get(usr.UIDchannel).delete();
                    // Finally, verify user
                    await verifyMember(usr);
                }
                break;

            // Handle case 4: manual verification catchall
            case 4:
                // Handle if bot crashed between previous step and now
                if (prospectiveMembers === undefined) {
                    await roster.pullFromSheet();
                    prospectiveMembers = await roster.getMembers();
                }
                // Handle if and exec types `!setuser` to verify user
                if (message.member.roles.cache.has('751857955661545592') && message.content.substr(0,8) === '!setuser') {
                    let email = message.content.substr(9);      // Store email exec claims the user is

                    // Find user from roster sheet
                    for (let i = 0; i < prospectiveMembers.length; i++) {
                        let pMember = prospectiveMembers[i];    // Store roster member object

                        // Handles if supplied email matches a roster member
                        if (pMember.Email === email) {
                            usr.step = 5;                               // Set step to 5
                            usr.Phone = pMember.Phone;                  // Store phone
                            usr.Status = pMember.Status;                // Store user rank
                            usr.Roles = pMember.Roles;                  // Store user club roles
                            usr.Name = pMember.Name;                    // Store real name
                            usr.hasShow = pMember.hasShow;              // Store if user has show
                            await usr.member.setNickname(usr.Name);     // Set nickname to real name

                            // If user is exec give them that role
                            if (usr.Status === "Exec") {
                                await usr.member.roles.add('751857955661545592')
                            }
                            // Else if user is member give them that role
                            else if (usr.Status === "Member")  {
                                await usr.member.roles.add('756314927945351209')
                            }
                            // remove prospective member roles
                            await usr.member.roles.remove('756314502273695766')

                            // Add roles to user
                            for (let i = 0; i < usr.Roles.length; i++) {
                                // Find role object based on common name
                                let role = message.guild.roles.cache.find(role => role.name === usr.Roles[i]);
                                // If role object found apply role
                                if (role !== undefined) {
                                    await message.member.roles.add(role.id);
                                }
                            }

                            // If user has show give them studio role
                            if (usr.hasShow === "TRUE") {
                                await usr.member.roles.add('751858085882232964')
                            }

                            // Log manual verification
                            await bot.channels.cache.get('756932892193456240').send(`<@${message.author.id}> manually verified ${usr.Status} <@${usr.UID}> .\n**Name:** ${usr.Name}\n**Email:** ${usr.Email}\n**Phone:** ${usr.Phone}\n**Roles:** ${usr.Roles}\n**User has Show**: ${usr.hasShow}`)
                            // Delete temp verification channel
                            await message.guild.channels.cache.get(usr.UIDchannel).delete();
                            // Finally, verify user
                            await verifyMember(usr);
                        }
                    }
                }
                // If member could not be found with that email in roster list notify exec
                else await message.reply("I couldn't find a member with that email.")
                break;
        }
    }



    // Handles if an exec wants to know the member list currently verified
    if (message.content === "!members" && message.member.roles.cache.has('751857955661545592')) {
        let counter = 0;    // Initialize row counter to stay within character limit

        // As long as some members are stored there will be output
        if (verifiedMembers.members.length > 0) {

            // Store output variable
            let output = '';
            // Respond to acknowledge call
            await message.reply("Here are the current Members I have verified-");

            // Loop through stored member object to find members
            for (let i = 0;i<verifiedMembers.members.length;i++) {
                counter++;      // increment counter

                // If counter is less than 10 store name to output
                if (counter < 10) {
                    output = output + `\n ${verifiedMembers.members[i].Name}`
                }
                // if counter is equal to 10 store name as output and print output and set to 0
                if (counter === 10) {
                    counter = 0;
                    await bot.channels.cache.get(message.channel.id).send(output)
                }
            }
            // After loop, if counter is not a multiple of 10 there will be names not printed. Sending those here
            if (counter !== 0 || counter !== 10) {
                await bot.channels.cache.get(message.channel.id).send(output)
            }
        }
        // else if no members found notify exec
        else await message.reply("I couldn't find any verified members.")
    }
})

// I didn't write this part, stole it from some other repo :(
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

// Login both bots
expressApp.listen(config.listenPort, () => console.log('Express now listening for requests'));
bot.login(TOKEN);

// Remove simple var from array its in my default function list to add to all code. Unused for now
function arrayRemove(arr, value) { return arr.filter(function(ele){ return ele !== value; });}

// Remove an object from array based on attribute that has a given variable
function arrayObjectRemove(arr, attr, value) {
    let i = arr.length;
    while(i--){
        if( arr[i] && arr[i].hasOwnProperty(attr) && (arguments.length > 2 && arr[i][attr] === value ) ){
            arr.splice(i,1);
        }
    }
}

// Function to remove previously verified members
async function removeMember(member) {
    for (let i=0;i<verifiedMembers.members.length;i++) {
        if (verifiedMembers.members[i].UID === member.id) {
            let id = verifiedMembers.members[i].UID;
            await arrayObjectRemove(verifiedMembers.members, 'UID', member.id);
            await storeMembers();
            return (`Removed <@${id}> from my member list`);
        }
    }
    return (`That person isn't a member.`)
}

// Function to get the index of usr from newUserArray JSON object
async function getIndex(id) {
    for (let i=0; i < newUserArray.nonMembers.length; i++) {
        if (newUserArray.nonMembers[i].UIDchannel === id) {
            return i;
        } else return false;
    }
}

// Function to verify member
async function verifyMember(usr) {
    // This code could probably be reduced to only a couple lines
    let verifiedMember = {};                // Temp object to transfer usr info
    verifiedMember.Name = usr.Name;         // Transfer name
    verifiedMember.Status = usr.Status;     // Transfer status (member vs exec)
    verifiedMember.Roles = usr.Roles;       // Transfer club roles
    verifiedMember.Email = usr.Email;       // Transfer email
    verifiedMember.Phone = usr.Phone;       // Transfer phone
    verifiedMember.hasShow = usr.hasShow;   // Transfer if user has show
    verifiedMember.UID = usr.UID;           // Transfer discord UID
    verifiedMember.step = usr.step;         // Transfer what step the user is on

    // Add temp object to verifiedMember permanent JSON object
    verifiedMembers.members.push(verifiedMember);
    // Remove member from prospectiveMember array
    await arrayObjectRemove(newUserArray.nonMembers, 'UID', usr.UID)
    // Store prospectiveMember object
    await storeNonMembers();
    // Store member object
    await storeMembers();
}

// Function to get the stream title
async function getStreamTitle(){
    let user;   // initialize variable
    // try to get what user is currently online
    try {
        user = await curly.get('https://wileyradio.org/user.php',{'SSL_VERIFYPEER': false, 'FOLLOWLOCATION': true})
    }
    // On error set topic offline and disconnect bot
    catch(e) {
        console.log("Couldn't connect to Wiley host:")
        console.error(e);
        return ("Wiley Radio is Offline")
    }
    user = user.data;       // Set user to user from curly
    isOnline = true;        // Set station var online

    // If user is DJ Roomba the song data is stored separately
    if (user === 'DJ Roomba') {
        // Get song title
        let song = await curly.get('https://wileyradio.org/title.php',{'SSL_VERIFYPEER': false, 'FOLLOWLOCATION': true});
        song = song.data;                   // Store song name
        let status = user + ' | ' + song;   // Store output
        isOnline = true;                    // Set station var online
        return (status);                    // return output
    }
    // Else return the data which contains both show name and title
    else {
        return(user);
    }
}

// Function to both update the status and handle voice activity
async function updateStatus() {
    await bot.user.setActivity(await getStreamTitle()); // Call function to set user activity
    setTimeout(updateStatus, 5000);     // Loop function every 5 seconds

    // Handle if the bot goes offline
    if (!isOnline && nowOnline) {
        const channel = bot.channels.cache.get(process.env.RADIO_CHANNEL);
        try {
            channel.leave();
        } catch(e) {
            console.error(e);
        }
        nowOnline = false;
    }

    // Handle if the station is online but the stream isn't already running
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

// Function to load JSON objects
async function loadFiles() {
    let data = await fs.readFileSync("verifiedMembers.json");
    verifiedMembers = JSON.parse(data)
    data = await fs.readFileSync("nonMembers.json");
    newUserArray = JSON.parse(data);
    data = await fs.readFileSync("newUsers.json");
    newUsers = JSON.parse(data);
}

// Function to store Member object
async function storeMembers() {
    fs.writeFileSync("verifiedMembers.json", JSON.stringify(verifiedMembers, null, 4));
}


// Function to store users that haven't started the verification process
async function storeNewUsers() {
    fs.writeFileSync("newUsers.json", JSON.stringify(newUsers, null, 4));
}

// Function to store users that have started the verification process
async function storeNonMembers() {
    fs.writeFileSync("nonMembers.json", JSON.stringify(newUserArray, null, 4));
}

// Function to download media for discord<-->groupme bridge
function download(url, filename, callback) {
    request.head(url, (err, res, body) => {
        let downloadedLocation = path.join(tempDir, filename)
        let contentType = res.headers['content-type'];

        request(url).pipe(fs.createWriteStream(downloadedLocation)).on('close', () => callback(contentType, downloadedLocation));
    });
}

// Function to send Groupme message
function sendGroupMeMessage(message, attachments, callback) {
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