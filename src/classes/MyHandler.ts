import Handler from './Handler';
import Bot from './Bot';
import { Entry, EntryData } from './Pricelist';
import Commands from './Commands';
import CartQueue from './CartQueue';
import Inventory from './Inventory';
import { UnknownDictionary } from '../types/common';
import { Currency } from '../types/TeamFortress2';
import SKU from 'tf2-sku';
import request from '@nicklason/request-retry';
import sleepasync from 'sleep-async';

import SteamUser from 'steam-user';
import TradeOfferManager, { TradeOffer, PollData } from 'steam-tradeoffer-manager';
import pluralize from 'pluralize';
import SteamID from 'steamid';
import Currencies from 'tf2-currencies';
import async from 'async';

import moment from 'moment-timezone';

import log from '../lib/logger';
import * as files from '../lib/files';
import paths from '../resources/paths';
import { parseJSON, exponentialBackoff } from '../lib/helpers';
import TF2Inventory from './TF2Inventory';
import DiscordWebhook from './DiscordWebhook';
import Autokeys from './Autokeys';

export = class MyHandler extends Handler {
    private readonly commands: Commands;

    private readonly discord: DiscordWebhook;

    private readonly autokeys: Autokeys;

    readonly cartQueue: CartQueue;

    private groups: string[] = [];

    private friendsToKeep: string[] = [];

    private minimumScrap = 9;

    private minimumReclaimed = 9;

    private combineThreshold = 9;

    private dupeCheckEnabled = false;

    private minimumKeysDupeCheck = 0;

    private invalidValueException: number;

    private invalidValueExceptionSKU: string[] = [];

    private hasInvalidValueException = false;

    private reviewItems: {
        invalidItemsSKU: string[];
        invalidItemsValue: string[];
        overstockedItemsSKU: string[];
        dupedItemsSKU: string[];
        dupedFailedItemsSKU: string[];
    } = {
        invalidItemsSKU: [],
        invalidItemsValue: [],
        overstockedItemsSKU: [],
        dupedItemsSKU: [],
        dupedFailedItemsSKU: []
    };

    private isTradingKeys = false;

    private autoRelistNotSellingKeys = 0;

    private autoRelistNotBuyingKeys = 0;

    private customGameName: string;

    private backpackSlots = 0;

    private retryRequest;

    private isAcceptedWithInvalidItemsOrOverstocked = false;

    recentlySentMessage: UnknownDictionary<number> = {};

    constructor(bot: Bot) {
        super(bot);

        this.commands = new Commands(bot);
        this.cartQueue = new CartQueue(bot);
        this.discord = new DiscordWebhook(bot);
        this.autokeys = new Autokeys(bot);

        const minimumScrap = parseInt(process.env.MINIMUM_SCRAP);
        const minimumReclaimed = parseInt(process.env.MINIMUM_RECLAIMED);
        const combineThreshold = parseInt(process.env.METAL_THRESHOLD);

        const exceptionRef = parseInt(process.env.INVALID_VALUE_EXCEPTION_VALUE_IN_REF);

        let invalidValueExceptionSKU = parseJSON(process.env.INVALID_VALUE_EXCEPTION_SKUS);
        if (invalidValueExceptionSKU !== null && Array.isArray(invalidValueExceptionSKU)) {
            invalidValueExceptionSKU.forEach(function(sku: string) {
                if (sku === '' || !sku) {
                    invalidValueExceptionSKU = ['Not Set'];
                }
            });
            this.invalidValueExceptionSKU = invalidValueExceptionSKU;
        } else {
            log.warn(
                'You did not set invalid value excepted items SKU as an array, resetting to apply only for Unusual and Australium'
            );
            this.invalidValueExceptionSKU = [';5;u', ';11;australium'];
        }

        const customGameName = process.env.CUSTOM_PLAYING_GAME_NAME;

        if (!customGameName || customGameName === 'tf2-automatic') {
            this.customGameName = customGameName;
        } else {
            if (customGameName.length <= 45) {
                this.customGameName = customGameName + ' - tf2-automatic';
            } else {
                log.warn(
                    'Your custom game playing name is more than 45 characters, resetting to only "tf2-automatic"...'
                );
                this.customGameName = 'tf2-automatic';
            }
        }

        const exceptionRefFromEnv = exceptionRef === 0 || isNaN(exceptionRef) ? 0 : exceptionRef;
        this.invalidValueException = Currencies.toScrap(exceptionRefFromEnv);

        if (!isNaN(minimumScrap)) {
            this.minimumScrap = minimumScrap;
        }

        if (!isNaN(minimumReclaimed)) {
            this.minimumReclaimed = minimumReclaimed;
        }

        if (!isNaN(combineThreshold)) {
            this.combineThreshold = combineThreshold;
        }

        if (process.env.ENABLE_DUPE_CHECK === 'true') {
            this.dupeCheckEnabled = true;
        }

        const minimumKeysDupeCheck = parseInt(process.env.MINIMUM_KEYS_DUPE_CHECK);
        if (!isNaN(minimumKeysDupeCheck)) {
            this.minimumKeysDupeCheck = minimumKeysDupeCheck;
        }

        const groups = parseJSON(process.env.GROUPS);
        if (groups !== null && Array.isArray(groups)) {
            groups.forEach(function(groupID64) {
                if (!new SteamID(groupID64).isValid()) {
                    throw new Error(`Invalid group SteamID64 "${groupID64}"`);
                }
            });

            this.groups = groups;
        }

        const friendsToKeep = parseJSON(process.env.KEEP).concat(this.bot.getAdmins());
        if (friendsToKeep !== null && Array.isArray(friendsToKeep)) {
            friendsToKeep.forEach(function(steamID64) {
                if (!new SteamID(steamID64).isValid()) {
                    throw new Error(`Invalid SteamID64 "${steamID64}"`);
                }
            });

            this.friendsToKeep = friendsToKeep;
        }

        setInterval(() => {
            this.recentlySentMessage = {};
        }, 1000);
    }

    getFriendToKeep(): number {
        return this.friendsToKeep.length;
    }

    hasDupeCheckEnabled(): boolean {
        return this.dupeCheckEnabled;
    }

    getMinimumKeysDupeCheck(): number {
        return this.minimumKeysDupeCheck;
    }

    getCustomGame(): string {
        return this.customGameName;
    }

    getBackpackSlots(): number {
        return this.backpackSlots;
    }

    getAcceptedWithInvalidItemsOrOverstockedStatus(): boolean {
        return this.isAcceptedWithInvalidItemsOrOverstocked;
    }

    onRun(): Promise<{
        loginAttempts?: number[];
        pricelist?: EntryData[];
        loginKey?: string;
        pollData?: PollData;
    }> {
        return Promise.all([
            files.readFile(paths.files.loginKey, false),
            files.readFile(paths.files.pricelist, true),
            files.readFile(paths.files.loginAttempts, true),
            files.readFile(paths.files.pollData, true)
        ]).then(function([loginKey, pricelist, loginAttempts, pollData]) {
            return { loginKey, pricelist, loginAttempts, pollData };
        });
    }

    onReady(): void {
        log.info(
            'tf2autobot v' +
                process.env.BOT_VERSION +
                ' is ready! ' +
                pluralize('item', this.bot.pricelist.getLength(), true) +
                ' in pricelist, ' +
                pluralize('listing', this.bot.listingManager.listings.length, true) +
                ' on www.backpack.tf (cap: ' +
                this.bot.listingManager.cap +
                ')'
        );

        this.bot.client.gamesPlayed([this.customGameName, 440]);
        this.bot.client.setPersona(SteamUser.EPersonaState.Online);

        // GetBackpackSlots
        this.requestBackpackSlots();

        // Smelt / combine metal if needed
        this.keepMetalSupply();

        // Craft duplicate weapons
        this.craftDuplicateWeapons();

        // Auto sell and buy keys if ref < minimum
        this.autokeys.check();

        // Sort the inventory after crafting / combining metal
        this.sortInventory();

        // Check friend requests that we got while offline
        this.checkFriendRequests();

        // Check group invites that we got while offline
        this.checkGroupInvites();

        // Set up autorelist if enabled in environment variable
        this.bot.listings.setupAutorelist();
    }

    onShutdown(): Promise<void> {
        return new Promise(resolve => {
            if (this.bot.listingManager.ready !== true) {
                // We have not set up the listing manager, don't try and remove listings
                return resolve();
            }

            if (process.env.ENABLE_AUTO_SELL_AND_BUY_KEYS === 'true' && this.autokeys.isActive === true) {
                log.debug('Disabling Autokeys and removing key from pricelist...');
                this.autokeys.disable();
            }

            this.bot.listings.removeAll().asCallback(function(err) {
                if (err) {
                    log.warn('Failed to remove all listings: ', err);
                }

                resolve();
            });
        });
    }

    onLoggedOn(): void {
        if (this.bot.isReady()) {
            this.bot.client.setPersona(SteamUser.EPersonaState.Online);
            this.bot.client.gamesPlayed([this.customGameName, 440]);
        }
    }

    onMessage(steamID: SteamID, message: string): void {
        const steamID64 = steamID.toString();

        if (!this.bot.friends.isFriend(steamID64)) {
            return;
        }

        const friend = this.bot.friends.getFriend(steamID64);

        if (friend === null) {
            log.info(`Message from ${steamID64}: ${message}`);
        } else {
            log.info(`Message from ${friend.player_name} (${steamID64}): ${message}`);
        }

        if (this.recentlySentMessage[steamID64] !== undefined && this.recentlySentMessage[steamID64] >= 1) {
            return;
        }

        this.recentlySentMessage[steamID64] = this.recentlySentMessage[steamID64] + 1;

        this.commands.processMessage(steamID, message);
    }

    onLoginKey(loginKey: string): void {
        log.debug('New login key');

        files.writeFile(paths.files.loginKey, loginKey, false).catch(function(err) {
            log.warn('Failed to save login key: ', err);
        });
    }

    onLoginError(err: Error): void {
        // @ts-ignore
        if (err.eresult === SteamUser.EResult.InvalidPassword) {
            files.deleteFile(paths.files.loginKey).catch(err => {
                log.warn('Failed to delete login key: ', err);
            });
        }
    }

    onLoginAttempts(attempts: number[]): void {
        files.writeFile(paths.files.loginAttempts, attempts, true).catch(function(err) {
            log.warn('Failed to save login attempts: ', err);
        });
    }

    onFriendRelationship(steamID: SteamID, relationship: number): void {
        if (relationship === SteamUser.EFriendRelationship.Friend) {
            this.onNewFriend(steamID);
            this.checkFriendsCount(steamID);
        } else if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
            this.respondToFriendRequest(steamID);
        }
    }

    onGroupRelationship(groupID: SteamID, relationship: number): void {
        log.debug('Group relation changed', { steamID: groupID, relationship: relationship });
        if (relationship === SteamUser.EClanRelationship.Invited) {
            const join = this.groups.includes(groupID.getSteamID64());

            log.info(`Got invited to group ${groupID.getSteamID64()}, ${join ? 'accepting...' : 'declining...'}`);
            this.bot.client.respondToGroupInvite(groupID, this.groups.includes(groupID.getSteamID64()));
        } else if (relationship === SteamUser.EClanRelationship.Member) {
            log.info(`Joined group ${groupID.getSteamID64()}`);
        }
    }

    onBptfAuth(auth: { apiKey: string; accessToken: string }): void {
        const details = Object.assign({ private: true }, auth);

        log.warn('Please add the backpack.tf API key and access token to the environment variables!', details);
    }

    async onNewTradeOffer(
        offer: TradeOffer
    ): Promise<null | {
        action: 'accept' | 'decline' | 'skip';
        reason: string;
        meta?: UnknownDictionary<any>;
    }> {
        offer.log('info', 'is being processed...');

        // Allow sending notifications
        offer.data('notify', true);

        const ourItems = Inventory.fromItems(
            this.bot.client.steamID,
            offer.itemsToGive,
            this.bot.manager,
            this.bot.schema
        );

        const theirItems = Inventory.fromItems(offer.partner, offer.itemsToReceive, this.bot.manager, this.bot.schema);

        const items = {
            our: ourItems.getItems(),
            their: theirItems.getItems()
        };

        const exchange = {
            contains: { items: false, metal: false, keys: false },
            our: { value: 0, keys: 0, scrap: 0, contains: { items: false, metal: false, keys: false } },
            their: { value: 0, keys: 0, scrap: 0, contains: { items: false, metal: false, keys: false } }
        };

        const itemsDict = { our: {}, their: {} };

        const states = [false, true];

        let hasInvalidItems = false;

        for (let i = 0; i < states.length; i++) {
            const buying = states[i];
            const which = buying ? 'their' : 'our';

            for (const sku in items[which]) {
                if (!Object.prototype.hasOwnProperty.call(items[which], sku)) {
                    continue;
                }

                if (sku === 'unknown') {
                    // Offer contains an item that is not from TF2
                    hasInvalidItems = true;
                }

                if (sku === '5000;6') {
                    exchange.contains.metal = true;
                    exchange[which].contains.metal = true;
                } else if (sku === '5001;6') {
                    exchange.contains.metal = true;
                    exchange[which].contains.metal = true;
                } else if (sku === '5002;6') {
                    exchange.contains.metal = true;
                    exchange[which].contains.metal = true;
                } else if (sku === '5021;6') {
                    exchange.contains.keys = true;
                    exchange[which].contains.keys = true;
                } else {
                    exchange.contains.items = true;
                    exchange[which].contains.items = true;
                }

                const amount = items[which][sku].length;

                itemsDict[which][sku] = amount;
            }
        }

        offer.data('dict', itemsDict);

        // Check if the offer is from an admin
        if (this.bot.isAdmin(offer.partner)) {
            offer.log('trade', `is from an admin, accepting. Summary:\n${offer.summarize(this.bot.schema)}`);
            return { action: 'accept', reason: 'ADMIN' };
        }

        if (hasInvalidItems) {
            // Using boolean because items dict always needs to be saved
            offer.log('info', 'contains items not from TF2, declining...');
            return { action: 'decline', reason: '🟨INVALID_ITEMS_CONTAINS_NON_TF2' };
        }

        const itemsDiff = offer.getDiff();

        const offerMessage = offer.message.toLowerCase();

        const isGift = this.giftWords().some(word => {
            return offerMessage.includes(word);
        });

        if (offer.itemsToGive.length === 0 && isGift) {
            offer.log('trade', `is a gift offer, accepting. Summary:\n${offer.summarize(this.bot.schema)}`);
            return { action: 'accept', reason: 'GIFT' };
        } else if (offer.itemsToReceive.length === 0 || offer.itemsToGive.length === 0) {
            offer.log('info', 'is a gift offer, declining...');
            return { action: 'decline', reason: 'GIFT_NO_NOTE' };
        }

        // Check for Dueling Mini-Game for 5x Uses only when enabled and exist in pricelist

        const checkExist = this.bot.pricelist;

        if (process.env.DISABLE_CHECK_USES_DUELING_MINI_GAME !== 'true') {
            let hasNot5Uses = false;
            offer.itemsToReceive.forEach(item => {
                if (item.name === 'Dueling Mini-Game') {
                    for (let i = 0; i < item.descriptions.length; i++) {
                        const descriptionValue = item.descriptions[i].value;
                        const descriptionColor = item.descriptions[i].color;

                        if (
                            !descriptionValue.includes('This is a limited use item. Uses: 5') &&
                            descriptionColor === '00a000'
                        ) {
                            hasNot5Uses = true;
                            log.debug('info', `Dueling Mini-Game (${item.assetid}) is not 5 uses.`);
                            break;
                        }
                    }
                }
            });

            if (hasNot5Uses && checkExist.getPrice('241;6', true) !== null) {
                // Only decline if exist in pricelist
                offer.log('info', 'contains Dueling Mini-Game that are not 5 uses.');
                return { action: 'decline', reason: 'DUELING_NOT_5_USES' };
            }
        }

        // Check for Noise Maker for 25x Uses only when enabled and exist in pricelist

        if (process.env.DISABLE_CHECK_USES_NOISE_MAKER !== 'true') {
            let hasNot25Uses = false;
            offer.itemsToReceive.forEach(item => {
                const isNoiseMaker = this.noiseMakerNames().some(name => {
                    return item.name.includes(name);
                });
                if (isNoiseMaker) {
                    for (let i = 0; i < item.descriptions.length; i++) {
                        const descriptionValue = item.descriptions[i].value;
                        const descriptionColor = item.descriptions[i].color;

                        if (
                            !descriptionValue.includes('This is a limited use item. Uses: 25') &&
                            descriptionColor === '00a000'
                        ) {
                            hasNot25Uses = true;
                            log.debug('info', `${item.name} (${item.assetid}) is not 25 uses.`);
                            break;
                        }
                    }
                }
            });

            const isNoiseMaker = this.noiseMakerSKUs().some(sku => {
                return checkExist.getPrice(sku, true) !== null;
            });
            if (hasNot25Uses && isNoiseMaker) {
                offer.log('info', 'contains Noice Maker that are not 25 uses.');
                return { action: 'decline', reason: 'NOISE_MAKER_NOT_25_USES' };
            }
        }

        const manualReviewEnabled = process.env.ENABLE_MANUAL_REVIEW !== 'false';

        const itemPrices = {};

        const keyPrice = this.bot.pricelist.getKeyPrice();

        let hasOverstock = false;

        // A list of things that is wrong about the offer and other information
        const wrongAboutOffer: (
            | {
                  reason: '🟦OVERSTOCKED';
                  sku: string;
                  buying: boolean;
                  diff: number;
                  amountCanTrade: number;
              }
            | {
                  reason: '🟨INVALID_ITEMS';
                  sku: string;
                  buying: boolean;
                  amount: number;
              }
            | {
                  reason: '🟥INVALID_VALUE';
                  our: number;
                  their: number;
              }
            | {
                  reason: '🟪DUPE_CHECK_FAILED';
                  assetid?: string;
                  error?: string;
              }
            | {
                  reason: '🟫DUPED_ITEMS';
                  assetid: string;
              }
            | {
                  reason: '⬜STEAM_DOWN';
                  error?: string;
              }
            | {
                  reason: '⬜BACKPACKTF_DOWN';
                  error?: string;
              }
        )[] = [];

        let assetidsToCheck = [];
        let skuToCheck = [];

        for (let i = 0; i < states.length; i++) {
            const buying = states[i];
            const which = buying ? 'their' : 'our';
            const intentString = buying ? 'buy' : 'sell';
            const weapons = this.weapon();
            const craft = weapons.craft;
            const uncraft = weapons.uncraft;

            for (const sku in items[which]) {
                if (!Object.prototype.hasOwnProperty.call(items[which], sku)) {
                    continue;
                }

                const assetids = items[which][sku];
                const amount = assetids.length;

                if (sku === '5000;6') {
                    exchange[which].value += amount;
                    exchange[which].scrap += amount;
                } else if (sku === '5001;6') {
                    const value = 3 * amount;
                    exchange[which].value += value;
                    exchange[which].scrap += value;
                } else if (sku === '5002;6') {
                    const value = 9 * amount;
                    exchange[which].value += value;
                    exchange[which].scrap += value;
                } else if (
                    (craft.includes(sku) || uncraft.includes(sku)) &&
                    process.env.DISABLE_CRAFTWEAPON_AS_CURRENCY !== 'true' &&
                    this.bot.pricelist.getPrice(sku, true) === null
                ) {
                    const value = 0.5 * amount;
                    exchange[which].value += value;
                    exchange[which].scrap += value;
                } else {
                    const match = this.bot.pricelist.getPrice(sku, true);
                    const notIncludeCraftweapon =
                        process.env.DISABLE_CRAFTWEAPON_AS_CURRENCY !== 'true'
                            ? !(craft.includes(sku) || uncraft.includes(sku))
                            : true;

                    // TODO: Go through all assetids and check if the item is being sold for a specific price

                    if (match !== null && (sku !== '5021;6' || !exchange.contains.items)) {
                        // If we found a matching price and the item is not a key, or the we are not trading items (meaning that we are trading keys) then add the price of the item

                        // Add value of items
                        exchange[which].value += match[intentString].toValue(keyPrice.metal) * amount;
                        exchange[which].keys += match[intentString].keys * amount;
                        exchange[which].scrap += Currencies.toScrap(match[intentString].metal) * amount;

                        itemPrices[match.sku] = {
                            buy: match.buy,
                            sell: match.sell
                        };

                        // Check stock limits (not for keys)
                        const diff = itemsDiff[sku];

                        const buyingOverstockCheck = diff > 0;
                        const amountCanTrade = this.bot.inventoryManager.amountCanTrade(sku, buyingOverstockCheck);

                        if (diff !== 0 && amountCanTrade < diff && notIncludeCraftweapon) {
                            // User is taking too many / offering too many
                            hasOverstock = true;

                            this.reviewItems.overstockedItemsSKU.push(sku);

                            wrongAboutOffer.push({
                                reason: '🟦OVERSTOCKED',
                                sku: sku,
                                buying: buyingOverstockCheck,
                                diff: diff,
                                amountCanTrade: amountCanTrade
                            });
                        }

                        const buyPrice = match.buy.toValue(keyPrice.metal);
                        const sellPrice = match.sell.toValue(keyPrice.metal);
                        const minimumKeysDupeCheck = this.minimumKeysDupeCheck * keyPrice.toValue();

                        if (
                            buying && // check only items on their side
                            (buyPrice > minimumKeysDupeCheck || sellPrice > minimumKeysDupeCheck)
                            // if their side contains invalid_items, will use our side value
                        ) {
                            skuToCheck = skuToCheck.concat(sku);
                            assetidsToCheck = assetidsToCheck.concat(assetids);
                        }
                    } else if (sku === '5021;6' && exchange.contains.items) {
                        // Offer contains keys and we are not trading keys, add key value
                        exchange[which].value += keyPrice.toValue() * amount;
                        exchange[which].keys += amount;
                    } else if ((match === null && notIncludeCraftweapon) || match.intent === (buying ? 1 : 0)) {
                        // Offer contains an item that we are not trading
                        hasInvalidItems = true;

                        this.reviewItems.invalidItemsSKU.push(sku);

                        await sleepasync().Promise.sleep(1 * 1000);
                        const price = await this.bot.pricelist.getPricesTF(sku);

                        if (price === null) {
                            this.reviewItems.invalidItemsValue.push('No price');
                        } else {
                            price.buy = new Currencies(price.buy);
                            price.sell = new Currencies(price.sell);

                            if (process.env.DISABLE_GIVE_PRICE_TO_INVALID_ITEMS !== 'true') {
                                exchange[which].value += price[intentString].toValue(keyPrice.metal) * amount;
                                exchange[which].keys += price[intentString].keys * amount;
                                exchange[which].scrap += Currencies.toScrap(price[intentString].metal) * amount;
                            }
                            const itemSuggestedValue = Currencies.toCurrencies(
                                price[intentString].toValue(keyPrice.metal)
                            );
                            this.reviewItems.invalidItemsValue.push(itemSuggestedValue.toString());
                        }

                        wrongAboutOffer.push({
                            reason: '🟨INVALID_ITEMS',
                            sku: sku,
                            buying: buying,
                            amount: amount
                        });
                    }
                }
            }
        }

        // Doing this so that the prices will always be displayed as only metal
        if (process.env.ENABLE_SHOW_ONLY_METAL !== 'false') {
            exchange.our.scrap += exchange.our.keys * keyPrice.toValue();
            exchange.our.keys = 0;
            exchange.their.scrap += exchange.their.keys * keyPrice.toValue();
            exchange.their.keys = 0;
        }

        offer.data('value', {
            our: {
                total: exchange.our.value,
                keys: exchange.our.keys,
                metal: Currencies.toRefined(exchange.our.scrap)
            },
            their: {
                total: exchange.their.value,
                keys: exchange.their.keys,
                metal: Currencies.toRefined(exchange.their.scrap)
            },
            rate: keyPrice.metal
        });

        offer.data('prices', itemPrices);

        if (exchange.contains.metal && !exchange.contains.keys && !exchange.contains.items) {
            // Offer only contains metal
            offer.log('info', 'only contains metal, declining...');
            return { action: 'decline', reason: 'ONLY_METAL' };
        } else if (exchange.contains.keys && !exchange.contains.items) {
            // Offer is for trading keys, check if we are trading them
            const priceEntry = this.bot.pricelist.getPrice('5021;6', true);
            if (priceEntry === null) {
                // We are not trading keys
                this.autoRelistNotSellingKeys++;
                this.autoRelistNotBuyingKeys++;
                offer.log('info', 'we are not trading keys, declining...');
                return { action: 'decline', reason: 'NOT_TRADING_KEYS' };
            } else if (exchange.our.contains.keys && priceEntry.intent !== 1 && priceEntry.intent !== 2) {
                // We are not selling keys
                this.autoRelistNotSellingKeys++;
                offer.log('info', 'we are not selling keys, declining...');
                return { action: 'decline', reason: 'NOT_TRADING_KEYS' };
            } else if (exchange.their.contains.keys && priceEntry.intent !== 0 && priceEntry.intent !== 2) {
                // We are not buying keys
                this.autoRelistNotBuyingKeys++;
                offer.log('info', 'we are not buying keys, declining...');
                return { action: 'decline', reason: 'NOT_TRADING_KEYS' };
            } else {
                // Check overstock / understock on keys
                const diff = itemsDiff['5021;6'];
                // If the diff is greater than 0 then we are buying, less than is selling
                this.isTradingKeys = true;

                const buying = diff > 0;
                const amountCanTrade = this.bot.inventoryManager.amountCanTrade('5021;6', buying);

                if (diff !== 0 && amountCanTrade < diff) {
                    // User is taking too many / offering too many
                    hasOverstock = true;
                    wrongAboutOffer.push({
                        reason: '🟦OVERSTOCKED',
                        sku: '5021;6',
                        buying: buying,
                        diff: diff,
                        amountCanTrade: amountCanTrade
                    });
                }
            }
            if (this.autokeys.isEnabled !== false) {
                if (this.autoRelistNotSellingKeys > 2 || this.autoRelistNotBuyingKeys > 2) {
                    log.debug('Our key listings do not synced with Backpack.tf detected, auto-relist initialized.');
                    this.bot.listings.checkAllWithDelay();
                    this.autoRelistNotSellingKeys = 0;
                    this.autoRelistNotBuyingKeys = 0;
                }
            } else {
                this.autoRelistNotSellingKeys = 0;
                this.autoRelistNotBuyingKeys = 0;
            }
        }

        const exceptionSKU = this.invalidValueExceptionSKU;
        const itemsList = this.itemList(offer);
        const ourItemsSKU = itemsList.our;
        const theirItemsSKU = itemsList.their;

        const isOurItems = exceptionSKU.some((fromEnv: string) => {
            return ourItemsSKU.some((ourItemSKU: string) => {
                return ourItemSKU.includes(fromEnv);
            });
        });

        const isThierItems = exceptionSKU.some((fromEnv: string) => {
            return theirItemsSKU.some((theirItemSKU: string) => {
                return theirItemSKU.includes(fromEnv);
            });
        });

        const isExcept = isOurItems || isThierItems;
        const exceptionValue = this.invalidValueException;

        let hasInvalidValue = false;
        if (exchange.our.value > exchange.their.value) {
            if (!isExcept || (isExcept && exchange.our.value - exchange.their.value >= exceptionValue)) {
                // Check if the values are correct and is not include the exception sku
                // OR include the exception sku but the invalid value is more than or equal to exception value
                hasInvalidValue = true;
                this.hasInvalidValueException = false;
                wrongAboutOffer.push({
                    reason: '🟥INVALID_VALUE',
                    our: exchange.our.value,
                    their: exchange.their.value
                });
            } else if (isExcept && exchange.our.value - exchange.their.value < exceptionValue) {
                log.info(
                    `Contains ${exceptionSKU.join(' or ')} and difference is ${Currencies.toRefined(
                        exchange.our.value - exchange.their.value
                    )} ref which is less than your exception value of ${Currencies.toRefined(
                        exceptionValue
                    )} ref. Accepting/checking for other reasons...`
                );
                this.hasInvalidValueException = true;
            }
        }

        if (!manualReviewEnabled) {
            if (hasOverstock) {
                offer.log('info', 'is taking / offering too many, declining...');

                const reasons = wrongAboutOffer.map(wrong => wrong.reason);
                const uniqueReasons = reasons.filter(reason => reasons.includes(reason));

                return {
                    action: 'decline',
                    reason: '🟦OVERSTOCKED',
                    meta: {
                        uniqueReasons: uniqueReasons,
                        reasons: wrongAboutOffer
                    }
                };
            }

            if (hasInvalidValue) {
                // We are offering more than them, decline the offer
                offer.log('info', 'is not offering enough, declining...');

                const reasons = wrongAboutOffer.map(wrong => wrong.reason);
                const uniqueReasons = reasons.filter(reason => reasons.includes(reason));

                return {
                    action: 'decline',
                    reason: '🟥INVALID_VALUE',
                    meta: {
                        uniqueReasons: uniqueReasons,
                        reasons: wrongAboutOffer
                    }
                };
            }
        }

        if (exchange.our.value < exchange.their.value && process.env.ALLOW_OVERPAY === 'false') {
            offer.log('info', 'is offering more than needed, declining...');
            return { action: 'decline', reason: 'OVERPAY' };
        }

        // TODO: If we are receiving items, mark them as pending and use it to check overstock / understock for new offers

        offer.log('info', 'checking escrow...');

        try {
            const hasEscrow = await this.bot.checkEscrow(offer);

            if (hasEscrow) {
                offer.log('info', 'would be held if accepted, declining...');
                return { action: 'decline', reason: 'ESCROW' };
            }
        } catch (err) {
            log.warn('Failed to check escrow: ', err);
            wrongAboutOffer.push({
                reason: '⬜STEAM_DOWN'
            });
            const reasons = wrongAboutOffer.map(wrong => wrong.reason);
            const uniqueReasons = reasons.filter(reason => reasons.includes(reason));

            return {
                action: 'skip',
                reason: '⬜STEAM_DOWN',
                meta: {
                    uniqueReasons: uniqueReasons,
                    reasons: wrongAboutOffer
                }
            };
        }

        offer.log('info', 'checking bans...');

        try {
            const isBanned = await this.bot.checkBanned(offer.partner.getSteamID64());

            if (isBanned) {
                offer.log('info', 'partner is banned in one or more communities, declining...');
                return { action: 'decline', reason: 'BANNED' };
            }
        } catch (err) {
            log.warn('Failed to check banned: ', err);
            wrongAboutOffer.push({
                reason: '⬜BACKPACKTF_DOWN'
            });
            const reasons = wrongAboutOffer.map(wrong => wrong.reason);
            const uniqueReasons = reasons.filter(reason => reasons.includes(reason));

            return {
                action: 'skip',
                reason: '⬜BACKPACKTF_DOWN',
                meta: {
                    uniqueReasons: uniqueReasons,
                    reasons: wrongAboutOffer
                }
            };
        }

        if (this.dupeCheckEnabled && assetidsToCheck.length > 0) {
            offer.log('info', 'checking ' + pluralize('item', assetidsToCheck.length, true) + ' for dupes...');
            const inventory = new TF2Inventory(offer.partner, this.bot.manager);

            const requests = assetidsToCheck.map(assetid => {
                return (callback: (err: Error | null, result: boolean | null) => void): void => {
                    log.debug('Dupe checking ' + assetid + '...');
                    Promise.resolve(inventory.isDuped(assetid)).asCallback(function(err, result) {
                        log.debug('Dupe check for ' + assetid + ' done');
                        callback(err, result);
                    });
                };
            });

            try {
                const result: (boolean | null)[] = await Promise.fromCallback(function(callback) {
                    async.series(requests, callback);
                });

                log.debug('Got result from dupe checks on ' + assetidsToCheck.join(', '), { result: result });

                // Decline by default
                const declineDupes = process.env.DECLINE_DUPES !== 'false';

                for (let i = 0; i < result.length; i++) {
                    if (result[i] === true) {
                        // Found duped item
                        if (declineDupes) {
                            // Offer contains duped items, decline it
                            return {
                                action: 'decline',
                                reason: '🟫DUPED_ITEMS',
                                meta: { assetids: assetidsToCheck, result: result }
                            };
                        } else {
                            // Offer contains duped items but we don't decline duped items, instead add it to the wrong about offer list and continue
                            this.reviewItems.dupedItemsSKU = skuToCheck;
                            wrongAboutOffer.push({
                                reason: '🟫DUPED_ITEMS',
                                assetid: assetidsToCheck[i]
                            });
                        }
                    } else if (result[i] === null) {
                        // Could not determine if the item was duped, make the offer be pending for review
                        this.reviewItems.dupedFailedItemsSKU = skuToCheck;
                        wrongAboutOffer.push({
                            reason: '🟪DUPE_CHECK_FAILED',
                            assetid: assetidsToCheck[i]
                        });
                    }
                }
            } catch (err) {
                log.warn('Failed dupe check on ' + assetidsToCheck.join(', ') + ': ' + err.message);
                wrongAboutOffer.push({
                    reason: '🟪DUPE_CHECK_FAILED',
                    error: err.message
                });
            }
        }

        this.isAcceptedWithInvalidItemsOrOverstocked = false;
        if (wrongAboutOffer.length !== 0) {
            const reasons = wrongAboutOffer.map(wrong => wrong.reason);
            const uniqueReasons = reasons.filter(reason => reasons.includes(reason));

            const acceptingCondition =
                process.env.DISABLE_GIVE_PRICE_TO_INVALID_ITEMS === 'false' ||
                process.env.DISABLE_ACCEPT_OVERSTOCKED_OVERPAY === 'false'
                    ? exchange.our.value < exchange.their.value
                    : process.env.DISABLE_GIVE_PRICE_TO_INVALID_ITEMS === 'true'
                    ? exchange.our.value <= exchange.their.value
                    : false;

            // TO DO: Counter offer?
            //
            // if (
            //     uniqueReasons.includes('🟥INVALID_VALUE') &&
            //     !(
            //         uniqueReasons.includes('🟨INVALID_ITEMS') ||
            //         uniqueReasons.includes('🟦OVERSTOCKED') ||
            //         uniqueReasons.includes('🟫DUPED_ITEMS') ||
            //         uniqueReasons.includes('🟪DUPE_CHECK_FAILED')
            //     )
            // ) {
            //     const counteroffer = offer.counter();
            // }
            if (
                ((uniqueReasons.includes('🟨INVALID_ITEMS') &&
                    process.env.DISABLE_ACCEPT_INVALID_ITEMS_OVERPAY !== 'true') ||
                    (uniqueReasons.includes('🟦OVERSTOCKED') &&
                        process.env.DISABLE_ACCEPT_OVERSTOCKED_OVERPAY !== 'true')) &&
                !(
                    uniqueReasons.includes('🟥INVALID_VALUE') ||
                    uniqueReasons.includes('🟫DUPED_ITEMS') ||
                    uniqueReasons.includes('🟪DUPE_CHECK_FAILED')
                ) &&
                acceptingCondition &&
                exchange.our.value !== 0
            ) {
                this.isAcceptedWithInvalidItemsOrOverstocked = true;
                offer.log(
                    'trade',
                    `contains invalid items/overstocked, but offer more or equal value, accepting. Summary:\n${offer.summarize(
                        this.bot.schema
                    )}`
                );
                return { action: 'accept', reason: 'VALID' };
            } else if (
                // If only INVALID_VALUE and did not matched exception value, will just decline the trade.
                process.env.DISABLE_AUTO_DECLINE_INVALID_VALUE !== 'true' &&
                uniqueReasons.includes('🟥INVALID_VALUE') &&
                !(
                    uniqueReasons.includes('🟨INVALID_ITEMS') ||
                    uniqueReasons.includes('🟦OVERSTOCKED') ||
                    uniqueReasons.includes('🟫DUPED_ITEMS') ||
                    uniqueReasons.includes('🟪DUPE_CHECK_FAILED')
                ) &&
                this.hasInvalidValueException === false
            ) {
                return { action: 'decline', reason: 'ONLY_INVALID_VALUE' };
            } else {
                offer.log('info', `offer needs review (${uniqueReasons.join(', ')}), skipping...`);
                return {
                    action: 'skip',
                    reason: 'REVIEW',
                    meta: {
                        uniqueReasons: uniqueReasons,
                        reasons: wrongAboutOffer
                    }
                };
            }
        }

        offer.log('trade', `accepting. Summary:\n${offer.summarize(this.bot.schema)}`);

        return { action: 'accept', reason: 'VALID' };
    }

    private sleep(mili: number): void {
        const date = moment().valueOf();
        let currentDate = null;
        do {
            currentDate = moment().valueOf();
        } while (currentDate - date < mili);
    }

    // TODO: checkBanned and checkEscrow are copied from UserCart, don't duplicate them

    onTradeOfferChanged(offer: TradeOffer, oldState: number): void {
        // Not sure if it can go from other states to active
        if (oldState === TradeOfferManager.ETradeOfferState.Accepted) {
            offer.data('switchedState', oldState);
        }

        const handledByUs = offer.data('handledByUs') === true;
        const notify = offer.data('notify') === true;

        if (handledByUs && offer.data('switchedState') !== offer.state) {
            if (notify) {
                if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                    this.bot.sendMessage(
                        offer.partner,
                        process.env.CUSTOM_SUCCESS_MESSAGE
                            ? process.env.CUSTOM_SUCCESS_MESSAGE
                            : '/pre ✅ Success! The offer went through successfully.'
                    );
                } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                    this.bot.sendMessage(
                        offer.partner,
                        '✅ Success! The offer went through successfully, but you will receive your items after ~15 days.' +
                            ' Please use Steam Guard Mobile Authenticator so you will no longer need to wait like this in the future.' +
                            '\nRead:\n' +
                            '• Steam Guard Mobile Authenticator - https://support.steampowered.com/kb_article.php?ref=8625-WRAH-9030' +
                            '• Steam Guard: How to set up a Steam Guard Mobile Authenticator - https://support.steampowered.com/kb_article.php?ref=4440-RTUI-9218'
                    );
                } else if (offer.state === TradeOfferManager.ETradeOfferState.Declined) {
                    const offerReason: { reason: string } = offer.data('action');
                    const keyPrice = this.bot.pricelist.getKeyPrices();
                    const value = this.valueDiff(offer, keyPrice);
                    const itemsList = this.itemList(offer);

                    let reasonForInvalidValue = false;
                    let reason: string;
                    if (!offerReason) {
                        reason = '';
                    } else if (offerReason.reason === 'GIFT_NO_NOTE') {
                        reason = `the offer you've sent is an empty offer on my side without any offer message. If you wish to give it as a gift, please include "gift" in the offer message. Thank you.`;
                    } else if (offerReason.reason === 'DUELING_NOT_5_USES') {
                        reason = 'your offer contains Dueling Mini-Game that are not 5 uses.';
                    } else if (offerReason.reason === 'NOISE_MAKER_NOT_25_USES') {
                        reason = 'your offer contains Noise Maker that are not 25 uses.';
                    } else if (offerReason.reason === 'NOT_TRADING_KEYS') {
                        reason =
                            'I am no longer trading keys. You can confirm it by adding me and send "!price Mann Co. Supply Crate Key" or "!autokeys".';
                    } else if (offerReason.reason === 'BANNED') {
                        reason =
                            "you're currently banned on backpack.tf or marked SCAMMER on steamrep.com or other community.";
                    } else if (offerReason.reason === 'ESCROW') {
                        reason =
                            'I do not accept trade hold (Escrow). Please use Steam Guard Mobile Authenticator so you will no longer need to wait like this in the future.' +
                            '\nRead:\n' +
                            '• Steam Guard Mobile Authenticator - https://support.steampowered.com/kb_article.php?ref=8625-WRAH-9030' +
                            '• Steam Guard: How to set up a Steam Guard Mobile Authenticator - https://support.steampowered.com/kb_article.php?ref=4440-RTUI-9218';
                    } else if (offerReason.reason === 'ONLY_INVALID_VALUE') {
                        reasonForInvalidValue = true;
                        reason = "you've sent a trade with an invalid value (your side and my side did not matched).";
                    } else {
                        reason = '';
                    }
                    this.bot.sendMessage(
                        offer.partner,
                        process.env.CUSTOM_DECLINED_MESSAGE
                            ? process.env.CUSTOM_DECLINED_MESSAGE
                            : `/pre ❌ Ohh nooooes! The offer is no longer available. Reason: The offer has been declined${
                                  reason ? ` because ${reason}` : '.'
                              }` +
                                  (reasonForInvalidValue
                                      ? '\n\nSummary:\n' +
                                        offer
                                            .summarize(this.bot.schema)
                                            .replace('Asked', '  My side')
                                            .replace('Offered', 'Your side') +
                                        "\n[You're missing: " +
                                        (itemsList.their.includes('5021;6')
                                            ? `${value.diffKey}]`
                                            : `${value.diffRef} ref]`) +
                                        `${
                                            process.env.AUTO_DECLINE_INVALID_VALUE_NOTE
                                                ? '\n\nNote from owner: ' + process.env.AUTO_DECLINE_INVALID_VALUE_NOTE
                                                : ''
                                        }`
                                      : '')
                    );
                } else if (offer.state === TradeOfferManager.ETradeOfferState.Canceled) {
                    let reason: string;

                    if (offer.data('canceledByUser') === true) {
                        reason = 'Offer was canceled by user';
                    } else if (oldState === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation) {
                        reason = 'Failed to accept mobile confirmation';
                    } else {
                        reason =
                            "The offer has been active for a while. If the offer was just created, this is likely an issue on Steam's end. Please try again later";
                    }

                    this.bot.sendMessage(
                        offer.partner,
                        '/pre ❌ Ohh nooooes! The offer is no longer available. Reason: ' + reason + '.'
                    );
                } else if (offer.state === TradeOfferManager.ETradeOfferState.InvalidItems) {
                    this.bot.sendMessage(
                        offer.partner,
                        process.env.CUSTOM_TRADED_AWAY_MESSAGE
                            ? process.env.CUSTOM_TRADED_AWAY_MESSAGE
                            : '/pre ❌ Ohh nooooes! Your offer is no longer available. Reason: Items not available (traded away in a different trade).'
                    );
                }
            }

            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                // Only run this if the bot handled the offer

                offer.data('isAccepted', true);

                offer.log('trade', 'has been accepted.');

                // Auto sell and buy keys if ref < minimum

                this.autokeys.check();

                const autokeys = {
                    isEnabled: this.autokeys.isEnabled,
                    isActive: this.autokeys.isActive,
                    isBuying: this.autokeys.status.isBuyingKeys,
                    isBanking: this.autokeys.status.isBankingKeys
                };

                const pureStock = this.pureStock();
                const timeWithEmojis = this.timeWithEmoji();
                const links = this.tradePartnerLinks(offer.partner.toString());
                const itemsList = this.itemList(offer);
                const currentItems = this.bot.inventoryManager.getInventory().getTotalItems();

                const invalidItemsName: string[] = [];
                const invalidItemsCombine: string[] = [];
                const isAcceptedInvalidItemsOverpay = this.isAcceptedWithInvalidItemsOrOverstocked;

                if (isAcceptedInvalidItemsOverpay) {
                    this.reviewItems.invalidItemsSKU.forEach(sku => {
                        const name = this.bot.schema.getName(SKU.fromString(sku), false);
                        invalidItemsName.push(name);
                    });

                    for (let i = 0; i < invalidItemsName.length; i++) {
                        invalidItemsCombine.push(invalidItemsName[i] + ' - ' + this.reviewItems.invalidItemsValue[i]);
                    }
                }

                const keyPrice = this.bot.pricelist.getKeyPrices();
                const value = this.valueDiff(offer, keyPrice);

                if (
                    process.env.DISABLE_DISCORD_WEBHOOK_TRADE_SUMMARY === 'false' &&
                    this.discord.tradeSummaryLinks.length !== 0
                ) {
                    this.discord.sendTradeSummary(
                        offer,
                        autokeys,
                        currentItems,
                        this.backpackSlots,
                        invalidItemsCombine,
                        keyPrice,
                        value,
                        itemsList,
                        links,
                        timeWithEmojis.time
                    );
                } else {
                    this.bot.messageAdmins(
                        'trade',
                        `/me Trade #${offer.id} with ${offer.partner.getSteamID64()} is accepted. ✅` +
                            summarizeSteamChat(offer.summarize(this.bot.schema), value, keyPrice) +
                            (isAcceptedInvalidItemsOverpay
                                ? '\n\n🟨INVALID_ITEMS:\n' + invalidItemsCombine.join(',\n')
                                : '') +
                            `\n🔑 Key rate: ${keyPrice.buy.metal.toString()}/${keyPrice.sell.metal.toString()} ref` +
                            `${
                                autokeys.isEnabled
                                    ? ' | Autokeys: ' +
                                      (autokeys.isActive
                                          ? '✅' +
                                            (autokeys.isBanking
                                                ? ' (banking)'
                                                : autokeys.isBuying
                                                ? ' (buying)'
                                                : ' (selling)')
                                          : '🛑')
                                    : ''
                            }` +
                            `\n💰 Pure stock: ${pureStock.join(', ').toString()}` +
                            `\n🎒 Total items: ${currentItems}`,
                        []
                    );
                }
            }
        }

        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            // Offer is accepted

            // Smelt / combine metal
            this.keepMetalSupply();

            // Craft duplicated weapons
            this.craftDuplicateWeapons();

            // Sort inventory
            this.sortInventory();

            // Update listings
            const diff = offer.getDiff() || {};

            for (const sku in diff) {
                if (!Object.prototype.hasOwnProperty.call(diff, sku)) {
                    continue;
                }

                this.bot.listings.checkBySKU(sku);
            }

            this.inviteToGroups(offer.partner);

            this.sleep(3000);

            // clear/reset these in memory
            this.reviewItems.invalidItemsSKU.length = 0;
            this.reviewItems.invalidItemsValue.length = 0;
            this.reviewItems.overstockedItemsSKU.length = 0;
            this.reviewItems.dupedItemsSKU.length = 0;
            this.reviewItems.dupedFailedItemsSKU.length = 0;
        }
    }

    onOfferAction(
        offer: TradeOffer,
        action: 'accept' | 'decline' | 'skip',
        reason: string,
        meta: UnknownDictionary<any>
    ): void {
        const notify = offer.data('notify') === true;
        if (!notify) {
            return;
        }

        const keyPrice = this.bot.pricelist.getKeyPrices();
        const pureStock = this.pureStock();
        const value = this.valueDiff(offer, keyPrice);
        const timeWithEmojis = this.timeWithEmoji();
        const links = this.tradePartnerLinks(offer.partner.toString());
        const itemsList = this.itemList(offer);

        if (action === 'skip') {
            const reviewReasons: string[] = [];
            let note: string;
            let missingPureNote: string;
            const invalidItemsName: string[] = [];
            const invalidItemsCombine: string[] = [];
            const overstockedItemsName: string[] = [];
            const dupedItemsName: string[] = [];
            const dupedFailedItemsName: string[] = [];
            const reasons = meta.uniqueReasons;

            if (reasons.includes('🟨INVALID_ITEMS')) {
                this.reviewItems.invalidItemsSKU.forEach(sku => {
                    const name = this.bot.schema.getName(SKU.fromString(sku), false);
                    invalidItemsName.push(name);
                });

                for (let i = 0; i < invalidItemsName.length; i++) {
                    invalidItemsCombine.push(invalidItemsName[i] + ' - ' + this.reviewItems.invalidItemsValue[i]);
                }

                note = process.env.INVALID_ITEMS_NOTE
                    ? `🟨INVALID_ITEMS - ${process.env.INVALID_ITEMS_NOTE}`
                          .replace(/%name%/g, invalidItemsName.join(', '))
                          .replace(/%isName%/, pluralize('is', invalidItemsName.length))
                    : `🟨INVALID_ITEMS - %name% ${pluralize(
                          'is',
                          invalidItemsName.length
                      )} not in my pricelist. Please wait for the response from my owner.`.replace(
                          /%name%/g,
                          invalidItemsName.join(', ')
                      );
                reviewReasons.push(note);
            }

            if (reasons.includes('🟦OVERSTOCKED')) {
                this.reviewItems.overstockedItemsSKU.forEach(sku => {
                    const name = this.bot.schema.getName(SKU.fromString(sku), false);
                    overstockedItemsName.push(name);
                });

                note = process.env.OVERSTOCKED_NOTE
                    ? `🟦OVERSTOCKED - ${process.env.OVERSTOCKED_NOTE}`
                          .replace(/%name%/g, overstockedItemsName.join(', '))
                          .replace(/%isName%/, pluralize('is', overstockedItemsName.length))
                    : `🟦OVERSTOCKED - %name% ${pluralize(
                          'is',
                          overstockedItemsName.length
                      )} already reached max amount I can have. Please wait for the response from my owner.`.replace(
                          /%name%/g,
                          overstockedItemsName.join(', ')
                      );
                reviewReasons.push(note);
            }

            if (reasons.includes('🟫DUPED_ITEMS')) {
                this.reviewItems.dupedItemsSKU.forEach(sku => {
                    const name = this.bot.schema.getName(SKU.fromString(sku), false);
                    dupedItemsName.push(name);
                });

                note = process.env.DUPE_ITEMS_NOTE
                    ? `🟫DUPED_ITEMS - ${process.env.DUPE_ITEMS_NOTE}`
                          .replace(/%name%/g, dupedItemsName.join(', '))
                          .replace(/%isName%/, pluralize('is', dupedItemsName.length))
                    : `🟫DUPED_ITEMS - %name% ${pluralize(
                          'is',
                          dupedItemsName.length
                      )} appeared to be duped. Please wait for my owner to review it. Thank you.`.replace(
                          /%name%/g,
                          dupedItemsName.join(', ')
                      );
                reviewReasons.push(note);
            }

            if (reasons.includes('🟪DUPE_CHECK_FAILED')) {
                this.reviewItems.dupedFailedItemsSKU.forEach(sku => {
                    const name = this.bot.schema.getName(SKU.fromString(sku), false);
                    dupedFailedItemsName.push(name);
                });

                note = process.env.DUPE_CHECK_FAILED_NOTE
                    ? `🟪DUPE_CHECK_FAILED - ${process.env.DUPE_CHECK_FAILED_NOTE}`
                          .replace(/%name%/g, dupedFailedItemsName.join(', '))
                          .replace(/%isName%/, pluralize('is', dupedFailedItemsName.length))
                    : `🟪DUPE_CHECK_FAILED - Backpack.tf still does not recognize %name% Original ${pluralize(
                          'ID',
                          dupedFailedItemsName.length
                      )} to check for the duped item. You can try again later. Check it yourself by going to your item history page. Thank you.`.replace(
                          /%name%/g,
                          dupedFailedItemsName.join(', ')
                      );
                reviewReasons.push(note);
            }

            if (reasons.includes('🟥INVALID_VALUE') && !reasons.includes('🟨INVALID_ITEMS')) {
                note = process.env.INVALID_VALUE_NOTE
                    ? `🟥INVALID_VALUE - ${process.env.INVALID_VALUE_NOTE}`
                    : '🟥INVALID_VALUE - Your offer will be ignored. Please cancel it and make another offer with correct value.';
                reviewReasons.push(note);
                missingPureNote =
                    "\n[You're missing: " +
                    (itemsList.their.includes('5021;6') ? `${value.diffKey}]` : `${value.diffRef} ref]`);
            }
            // Notify partner and admin that the offer is waiting for manual review
            if (reasons.includes('⬜BACKPACKTF_DOWN') || reasons.includes('⬜STEAM_DOWN')) {
                this.bot.sendMessage(
                    offer.partner,
                    (reasons.includes('⬜BACKPACKTF_DOWN') ? 'Backpack.tf' : 'Steam') +
                        ' is down and I failed to check your ' +
                        (reasons.includes('⬜BACKPACKTF_DOWN') ? 'backpack.tf' : 'Escrow') +
                        ' status, please wait for my owner to manually accept/decline your offer.'
                );
            } else {
                this.bot.sendMessage(
                    offer.partner,
                    `⚠️ Your offer is waiting for review.\nReason: ${reasons.join(', ')}` +
                        (process.env.DISABLE_SHOW_REVIEW_OFFER_SUMMARY !== 'true'
                            ? '\n\nYour offer summary:\n' +
                              offer
                                  .summarize(this.bot.schema)
                                  .replace('Asked', '  My side')
                                  .replace('Offered', 'Your side') +
                              (reasons.includes('🟥INVALID_VALUE') && !reasons.includes('🟨INVALID_ITEMS')
                                  ? missingPureNote
                                  : '') +
                              (process.env.DISABLE_REVIEW_OFFER_NOTE !== 'true'
                                  ? `\n\nNote:\n${reviewReasons.join('\n')}`
                                  : '')
                            : '') +
                        (process.env.ADDITIONAL_NOTE
                            ? '\n\n' +
                              process.env.ADDITIONAL_NOTE.replace(
                                  /%keyRate%/g,
                                  `${keyPrice.sell.metal.toString()} ref`
                              ).replace(/%pureStock%/g, pureStock.join(', ').toString())
                            : '') +
                        (process.env.DISABLE_SHOW_CURRENT_TIME !== 'true'
                            ? `\n\nMy owner time is currently at ${timeWithEmojis.emoji} ${timeWithEmojis.time +
                                  (timeWithEmojis.note !== '' ? `. ${timeWithEmojis.note}.` : '.')}`
                            : '')
                );
            }
            if (
                process.env.DISABLE_DISCORD_WEBHOOK_OFFER_REVIEW === 'false' &&
                process.env.DISCORD_WEBHOOK_REVIEW_OFFER_URL
            ) {
                this.discord.sendOfferReview(
                    offer,
                    reasons.join(', '),
                    timeWithEmojis.time,
                    keyPrice,
                    value,
                    links,
                    invalidItemsCombine,
                    overstockedItemsName,
                    dupedItemsName,
                    dupedFailedItemsName
                );
            } else {
                const offerMessage = offer.message;
                this.bot.messageAdmins(
                    `⚠️ Offer #${offer.id} from ${offer.partner} is waiting for review.` +
                        `\nReason: ${meta.uniqueReasons.join(', ')}` +
                        (reasons.includes('⬜BACKPACKTF_DOWN')
                            ? '\nBackpack.tf down, please manually check if this person is banned before accepting the offer.'
                            : reasons.includes('⬜STEAM_DOWN')
                            ? '\nSteam down, please manually check if this person have escrow.'
                            : '') +
                        summarizeSteamChat(offer.summarize(this.bot.schema), value, keyPrice) +
                        `${offerMessage.length !== 0 ? `\n\n💬 Offer message: "${offerMessage}"` : ''}` +
                        `${listItems(invalidItemsName, overstockedItemsName, dupedItemsName, dupedFailedItemsName)}` +
                        `\n\nSteam: ${links.steamProfile}\nBackpack.tf: ${links.backpackTF}\nSteamREP: ${links.steamREP}` +
                        `\n\n🔑 Key rate: ${keyPrice.buy.metal.toString()}/${keyPrice.sell.metal.toString()} ref` +
                        `\n💰 Pure stock: ${pureStock.join(', ').toString()}`,
                    []
                );
            }
            // clear/reset these in memory
            this.reviewItems.invalidItemsSKU.length = 0;
            this.reviewItems.invalidItemsValue.length = 0;
            this.reviewItems.overstockedItemsSKU.length = 0;
            this.reviewItems.dupedItemsSKU.length = 0;
            this.reviewItems.dupedFailedItemsSKU.length = 0;
        }
    }

    private keepMetalSupply(): void {
        if (process.env.DISABLE_CRAFTING === 'true' || process.env.DISABLE_CRAFTING_METAL === 'true') {
            return;
        }
        const pure = this.currPure();

        // let refined = pure.ref;
        let reclaimed = pure.rec * 3; // Because it was divided by 3
        let scrap = pure.scrap * 9; // Because it was divided by 9

        // const maxRefined = this.maximumRefined;
        const maxReclaimed = this.minimumReclaimed + this.combineThreshold;
        const maxScrap = this.minimumScrap + this.combineThreshold;
        // const minRefined = this.minimumRefined;
        const minReclaimed = this.minimumReclaimed;
        const minScrap = this.minimumScrap;

        let smeltReclaimed = 0;
        let smeltRefined = 0;
        let combineScrap = 0;
        let combineReclaimed = 0;

        if (reclaimed > maxReclaimed) {
            combineReclaimed = Math.ceil((reclaimed - maxReclaimed) / 3);
            // refined += combineReclaimed;
            reclaimed -= combineReclaimed * 3;
        } else if (minReclaimed > reclaimed) {
            smeltRefined = Math.ceil((minReclaimed - reclaimed) / 3);
            reclaimed += smeltRefined * 3;
            // refined -= smeltRefined;
        }

        if (scrap > maxScrap) {
            combineScrap = Math.ceil((scrap - maxScrap) / 3);
            reclaimed += combineScrap;
            scrap -= combineScrap * 3;
        } else if (minScrap > scrap) {
            smeltReclaimed = Math.ceil((minScrap - scrap) / 3);
            scrap += smeltReclaimed * 3;
            reclaimed -= smeltReclaimed;
        }

        // TODO: When smelting metal mark the item as being used, then we won't use it when sending offers

        for (let i = 0; i < combineScrap; i++) {
            this.bot.tf2gc.combineMetal(5000);
        }

        for (let i = 0; i < combineReclaimed; i++) {
            this.bot.tf2gc.combineMetal(5001);
        }

        for (let i = 0; i < smeltRefined; i++) {
            this.bot.tf2gc.smeltMetal(5002);
        }

        for (let i = 0; i < smeltReclaimed; i++) {
            this.bot.tf2gc.smeltMetal(5001);
        }
    }

    private craftDuplicateWeapons(): Promise<void> {
        if (process.env.DISABLE_CRAFTING_WEAPONS === 'true') {
            return;
        }
        const currencies = this.bot.inventoryManager.getInventory().getCurrencies();

        for (const sku of this.weapon().craft) {
            const weapon = currencies[sku].length;

            if (weapon >= 2 && this.bot.pricelist.getPrice(sku, true) === null) {
                // Only craft if duplicated and not exist in pricelist
                const combineWeapon = Math.trunc(weapon / 2);

                for (let i = 0; i < combineWeapon; i++) {
                    // give a little time between each craft job
                    this.bot.tf2gc.combineWeapon(sku);
                }
            }
        }
    }

    private sortInventory(): void {
        if (process.env.DISABLE_INVENTORY_SORT !== 'true') {
            this.bot.tf2gc.sortInventory(3);
        }
    }

    private inviteToGroups(steamID: SteamID | string): void {
        if (process.env.DISABLE_GROUPS_INVITE === 'true') {
            // You still need to include the group ID in your env.
            return;
        }
        this.bot.groups.inviteToGroups(steamID, this.groups);
    }

    private checkFriendRequests(): void {
        if (!this.bot.client.myFriends) {
            return;
        }

        this.checkFriendsCount();

        for (const steamID64 in this.bot.client.myFriends) {
            if (!Object.prototype.hasOwnProperty.call(this.bot.client.myFriends, steamID64)) {
                continue;
            }

            const relation = this.bot.client.myFriends[steamID64];
            if (relation === SteamUser.EFriendRelationship.RequestRecipient) {
                this.respondToFriendRequest(steamID64);
            }
        }

        this.bot.getAdmins().forEach(steamID => {
            if (!this.bot.friends.isFriend(steamID)) {
                log.info(`Not friends with admin ${steamID}, sending friend request...`);
                this.bot.client.addFriend(steamID, function(err) {
                    if (err) {
                        log.warn('Failed to send friend request: ', err);
                    }
                });
            }
        });
    }

    private respondToFriendRequest(steamID: SteamID | string): void {
        const steamID64 = typeof steamID === 'string' ? steamID : steamID.getSteamID64();

        log.debug(`Sending friend request to ${steamID64}...`);

        this.bot.client.addFriend(steamID, function(err) {
            if (err) {
                log.warn(`Failed to send friend request to ${steamID64}: `, err);
                return;
            }

            log.debug('Friend request has been sent / accepted');
        });
    }

    private onNewFriend(steamID: SteamID, tries = 0): void {
        if (tries === 0) {
            log.debug(`Now friends with ${steamID.getSteamID64()}`);
        }

        const isAdmin = this.bot.isAdmin(steamID);

        setImmediate(() => {
            if (!this.bot.friends.isFriend(steamID)) {
                return;
            }

            const friend = this.bot.friends.getFriend(steamID);

            if (friend === null || friend.player_name === undefined) {
                tries++;

                if (tries >= 5) {
                    log.info(`I am now friends with ${steamID.getSteamID64()}`);

                    this.bot.sendMessage(
                        steamID,
                        process.env.CUSTOM_WELCOME_MESSAGE
                            ? process.env.CUSTOM_WELCOME_MESSAGE.replace(/%name%/g, '').replace(
                                  /%admin%/g,
                                  isAdmin ? '!help' : '!how2trade'
                              )
                            : `Hi! If you don't know how things work, please type "!` +
                                  (isAdmin ? 'help' : 'how2trade') +
                                  '"'
                    );
                    return;
                }

                log.debug('Waiting for name');

                // Wait for friend info to be available
                setTimeout(() => {
                    this.onNewFriend(steamID, tries);
                }, exponentialBackoff(tries - 1, 200));
                return;
            }

            log.info(`I am now friends with ${friend.player_name} (${steamID.getSteamID64()})`);

            this.bot.sendMessage(
                steamID,
                process.env.CUSTOM_WELCOME_MESSAGE
                    ? process.env.CUSTOM_WELCOME_MESSAGE.replace(/%name%/g, friend.player_name).replace(
                          /%admin%/g,
                          isAdmin ? '!help' : '!how2trade'
                      )
                    : `Hi ${friend.player_name}! If you don't know how things work, please type "!` +
                          (isAdmin ? 'help' : 'how2trade') +
                          '"'
            );
        });
    }

    private checkFriendsCount(steamIDToIgnore?: SteamID | string): void {
        log.debug('Checking friends count');
        const friends = this.bot.friends.getFriends();

        const friendslistBuffer = 20;

        const friendsToRemoveCount = friends.length + friendslistBuffer - this.bot.friends.maxFriends;

        log.debug(`Friends to remove: ${friendsToRemoveCount}`);

        if (friendsToRemoveCount > 0) {
            // We have friends to remove, find people with fewest trades and remove them
            const friendsWithTrades = this.bot.trades.getTradesWithPeople(friends);

            // Ignore friends to keep
            this.friendsToKeep.forEach(function(steamID) {
                delete friendsWithTrades[steamID];
            });

            if (steamIDToIgnore) {
                delete friendsWithTrades[steamIDToIgnore.toString()];
            }

            // Convert object into an array so it can be sorted
            const tradesWithPeople: { steamID: string; trades: number }[] = [];

            for (const steamID in friendsWithTrades) {
                if (!Object.prototype.hasOwnProperty.call(friendsWithTrades, steamID)) {
                    continue;
                }

                tradesWithPeople.push({ steamID: steamID, trades: friendsWithTrades[steamID] });
            }

            // Sorts people by trades and picks people with lowest amounts of trades
            const friendsToRemove = tradesWithPeople
                .sort((a, b) => a.trades - b.trades)
                .splice(0, friendsToRemoveCount);

            log.info(`Cleaning up friendslist, removing ${friendsToRemove.length} people...`);

            friendsToRemove.forEach(element => {
                this.bot.sendMessage(
                    element.steamID,
                    process.env.CUSTOM_CLEARING_FRIENDS_MESSAGE
                        ? process.env.CUSTOM_CLEARING_FRIENDS_MESSAGE
                        : '/quote I am cleaning up my friend list and you have been selected to be removed. Feel free to add me again if you want to trade at the other time!'
                );
                this.bot.client.removeFriend(element.steamID);
            });
        }
    }

    private requestBackpackSlots(): Promise<void> {
        return new Promise((resolve, reject) => {
            request(
                {
                    url: 'https://api.steampowered.com/IEconItems_440/GetPlayerItems/v0001/',
                    method: 'GET',
                    qs: {
                        key: this.bot.manager.apiKey,
                        steamid: this.bot.client.steamID.getSteamID64()
                    },
                    json: true,
                    gzip: true
                },
                (err, response, body) => {
                    if (err) {
                        // if failed, retry after 10 minutes.
                        log.warn('Failed to obtain backpack slots, retry in 10 minutes: ', err);
                        clearTimeout(this.retryRequest);
                        this.retryRequest = setTimeout(() => {
                            this.requestBackpackSlots();
                        }, 10 * 60 * 1000);
                        return reject();
                    }

                    if (body.result.status != 1) {
                        err = new Error(body.result.statusDetail);
                        err.status = body.result.status;
                        log.warn('Failed to obtain backpack slots, retry in 10 minutes: ', err);
                        // if failed, retry after 10 minutes.
                        clearTimeout(this.retryRequest);
                        this.retryRequest = setTimeout(() => {
                            this.requestBackpackSlots();
                        }, 10 * 60 * 1000);
                        return reject();
                    }

                    clearTimeout(this.retryRequest);
                    this.backpackSlots = body.result.num_backpack_slots;

                    return resolve();
                }
            );
        });
    }

    private itemList(offer: TradeOffer): { their: string[]; our: string[] } {
        const items: { our: {}; their: {} } = offer.data('dict');
        const their: string[] = [];
        for (const sku in items.their) {
            if (!Object.prototype.hasOwnProperty.call(items.their, sku)) {
                continue;
            }
            const theirItemsSku = sku;
            their.push(theirItemsSku);
        }

        const our: string[] = [];
        for (const sku in items.our) {
            if (!Object.prototype.hasOwnProperty.call(items.our, sku)) {
                continue;
            }
            const ourItemsSku = sku;
            our.push(ourItemsSku);
        }
        return { their, our };
    }

    private valueDiff(
        offer: TradeOffer,
        keyPrice: { buy: Currencies; sell: Currencies }
    ): { diff: number; diffRef: number; diffKey: string } {
        const value: { our: Currency; their: Currency } = offer.data('value');

        let diff: number;
        let diffRef: number;
        let diffKey: string;
        if (!value) {
            diff = 0;
            diffRef = 0;
            diffKey = '';
        } else {
            if (this.isTradingKeys === true) {
                diff =
                    new Currencies(value.their).toValue(keyPrice.buy.metal) -
                    new Currencies(value.our).toValue(keyPrice.sell.metal);
                this.isTradingKeys = false; // reset
            } else {
                diff =
                    new Currencies(value.their).toValue(keyPrice.sell.metal) -
                    new Currencies(value.our).toValue(keyPrice.sell.metal);
            }
            diffRef = Currencies.toRefined(Currencies.toScrap(Math.abs(diff * (1 / 9))));
            diffKey = Currencies.toCurrencies(
                Math.abs(diff),
                Math.abs(diff) >= keyPrice.sell.metal ? keyPrice.sell.metal : undefined
            ).toString();
        }
        return { diff, diffRef, diffKey };
    }

    tradePartnerLinks(steamID: string): { steamProfile: string; backpackTF: string; steamREP: string } {
        const links = {
            steamProfile: `https://steamcommunity.com/profiles/${steamID}`,
            backpackTF: `https://backpack.tf/profiles/${steamID}`,
            steamREP: `https://steamrep.com/profiles/${steamID}`
        };
        return links;
    }

    timeWithEmoji(): { time: string; emoji: string; note: string } {
        const time = moment()
            .tz(process.env.TIMEZONE ? process.env.TIMEZONE : 'UTC') //timezone format: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
            .format(process.env.CUSTOM_TIME_FORMAT ? process.env.CUSTOM_TIME_FORMAT : 'MMMM Do YYYY, HH:mm:ss ZZ'); // refer: https://www.tutorialspoint.com/momentjs/momentjs_format.htm

        const timeEmoji = moment()
            .tz(process.env.TIMEZONE ? process.env.TIMEZONE : 'UTC')
            .format();
        const emoji =
            timeEmoji.includes('T00:') || timeEmoji.includes('T12:')
                ? '🕛'
                : timeEmoji.includes('T01:') || timeEmoji.includes('T13:')
                ? '🕐'
                : timeEmoji.includes('T02:') || timeEmoji.includes('T14:')
                ? '🕑'
                : timeEmoji.includes('T03:') || timeEmoji.includes('T15:')
                ? '🕒'
                : timeEmoji.includes('T04:') || timeEmoji.includes('T16:')
                ? '🕓'
                : timeEmoji.includes('T05:') || timeEmoji.includes('T17:')
                ? '🕔'
                : timeEmoji.includes('T06:') || timeEmoji.includes('T18:')
                ? '🕕'
                : timeEmoji.includes('T07:') || timeEmoji.includes('T19:')
                ? '🕖'
                : timeEmoji.includes('T08:') || timeEmoji.includes('T20:')
                ? '🕗'
                : timeEmoji.includes('T09:') || timeEmoji.includes('T21:')
                ? '🕘'
                : timeEmoji.includes('T10:') || timeEmoji.includes('T22:')
                ? '🕙'
                : timeEmoji.includes('T11:') || timeEmoji.includes('T23:')
                ? '🕚'
                : '';

        const timeNote = process.env.TIME_ADDITIONAL_NOTES ? process.env.TIME_ADDITIONAL_NOTES : '';

        const timeWithEmoji = {
            time: time,
            emoji: emoji,
            note: timeNote
        };
        return timeWithEmoji;
    }

    pureStock(): string[] {
        const pureStock: string[] = [];
        const pure = this.currPure();
        const totalKeys = pure.key;
        const totalRefs = Currencies.toRefined(pure.refTotalInScrap);

        const pureCombine = [
            {
                name: pluralize('key', totalKeys),
                amount: totalKeys
            },
            {
                name: pluralize('ref', Math.trunc(totalRefs)),
                amount: totalRefs
            }
        ];
        for (let i = 0; i < pureCombine.length; i++) {
            pureStock.push(`${pureCombine[i].amount} ${pureCombine[i].name}`);
        }
        return pureStock;
    }

    currPure(): { key: number; scrap: number; rec: number; ref: number; refTotalInScrap: number } {
        const currencies = this.bot.inventoryManager.getInventory().getCurrencies();

        const currKeys = currencies['5021;6'].length;
        const currScrap = currencies['5000;6'].length * (1 / 9);
        const currRec = currencies['5001;6'].length * (1 / 3);
        const currRef = currencies['5002;6'].length;
        const currReftoScrap = Currencies.toScrap(currRef + currRec + currScrap);

        const pure = {
            key: currKeys,
            scrap: currScrap,
            rec: currRec,
            ref: currRef,
            refTotalInScrap: currReftoScrap
        };
        return pure;
    }

    polldata(): { totalDays: number; tradesTotal: number; trades24Hours: number; tradesToday: number } {
        const now = moment();
        const aDayAgo = moment().subtract(24, 'hour');
        const startOfDay = moment().startOf('day');

        let tradesToday = 0;
        let trades24Hours = 0;
        let tradesTotal = 0;

        const pollData = this.bot.manager.pollData;
        const oldestId = pollData.offerData === undefined ? undefined : Object.keys(pollData.offerData)[0];
        const timeSince =
            +process.env.TRADING_STARTING_TIME_UNIX === 0
                ? pollData.timestamps[oldestId]
                : +process.env.TRADING_STARTING_TIME_UNIX;
        const totalDays = !timeSince ? 0 : now.diff(moment.unix(timeSince), 'days');

        const offerData = this.bot.manager.pollData.offerData;
        for (const offerID in offerData) {
            if (!Object.prototype.hasOwnProperty.call(offerData, offerID)) {
                continue;
            }

            if (offerData[offerID].handledByUs === true && offerData[offerID].isAccepted === true) {
                // Sucessful trades handled by the bot
                tradesTotal++;

                if (offerData[offerID].finishTimestamp >= aDayAgo.valueOf()) {
                    // Within the last 24 hours
                    trades24Hours++;
                }

                if (offerData[offerID].finishTimestamp >= startOfDay.valueOf()) {
                    // All trades since 0:00 in the morning.
                    tradesToday++;
                }
            }
        }

        const polldata = {
            totalDays: totalDays,
            tradesTotal: tradesTotal,
            trades24Hours: trades24Hours,
            tradesToday: tradesToday
        };
        return polldata;
    }

    giftWords(): string[] {
        const words = [
            'gift',
            'donat', // So that 'donate' or 'donation' will also be accepted
            'tip', // All others are synonyms
            'tribute',
            'souvenir',
            'favor',
            'giveaway',
            'bonus',
            'grant',
            'bounty',
            'present',
            'contribution',
            'award',
            'nice', // Up until here actually
            'happy', // All below people might also use
            'thank',
            'goo', // For 'good', 'goodie' or anything else
            'awesome',
            'rep',
            'joy',
            'cute' // right?
        ];
        return words;
    }

    noiseMakerNames(): string[] {
        const names = [
            'Noise Maker - Black Cat',
            'Noise Maker - Gremlin',
            'Noise Maker - Werewolf',
            'Noise Maker - Witch',
            'Noise Maker - Banshee',
            'Noise Maker - Crazy Laugh',
            'Noise Maker - Stabby',
            'Noise Maker - Bell',
            'Noise Maker - Gong',
            'Noise Maker - Koto',
            'Noise Maker - Fireworks',
            'Noise Maker - Vuvuzela'
        ];
        return names;
    }

    noiseMakerSKUs(): string[] {
        const skus = [
            '280;6', // Noise Maker - Black Cat
            '280;6;uncraftable',
            '281;6', // Noise Maker - Gremlin
            '281;6;uncraftable',
            '282;6', // Noise Maker - Werewolf
            '282;6;uncraftable',
            '283;6', // Noise Maker - Witch
            '283;6;uncraftable',
            '284;6', // Noise Maker - Banshee
            '284;6;uncraftable',
            '286;6', // Noise Maker - Crazy Laugh
            '286;6;uncraftable',
            '288;6', // Noise Maker - Stabby
            '288;6;uncraftable',
            '362;6', // Noise Maker - Bell
            '362;6;uncraftable',
            '364;6', // Noise Maker - Gong
            '364;6;uncraftable',
            '365;6', // Noise Maker - Koto
            '365;6;uncraftable',
            '365;1', // Genuine Noise Maker - Koto
            '493;6', // Noise Maker - Fireworks
            '493;6;uncraftable',
            '542;6', // Noise Maker - Vuvuzela
            '542;6;uncraftable',
            '542;1' // Genuine Noise Maker - Vuvuzela
        ];
        return skus;
    }

    weapon(): { craft: string[]; uncraft: string[] } {
        const weapons = {
            craft: [
                '45;6', // Force-A-Nature               == Scout/Primary ==
                '220;6', // Shortstop
                '448;6', // Soda Popper
                '772;6', // Baby Face's Blaster
                '1103;6', // Back Scatter
                '46;6', // Bonk! Atomic Punch           == Scout/Secondary ==
                '163;6', // Crit-a-Cola
                '222;6', // Mad Milk
                '449;6', // Winger
                '773;6', // Pretty Boy's Pocket Pistol
                '812;6', // Flying Guillotine
                '44;6', // Sandman                      == Scout/Melee ==
                '221;6', // Holy Mackerel
                '317;6', // Candy Cane
                '325;6', // Boston Basher
                '349;6', // Sun-on-a-Stick
                '355;6', // Fan O'War
                '450;6', // Atomizer
                '648;6', // Wrap Assassin
                '127;6', // Direct Hit                  == Soldier/Primary ==
                '228;6', // Black Box
                '237;6', // Rocket Jumper
                '414;6', // Liberty Launcher
                '441;6', // Cow Mangler 5000
                '513;6', // Original
                '730;6', // Beggar's Bazooka
                '1104;6', // Air Strike
                '129;6', // Buff Banner                 == Soldier/Secondary ==
                '133;6', // Gunboats
                '226;6', // Battalion's Backup
                '354;6', // Concheror
                '415;6', // (Reserve Shooter - Shared - Soldier/Pyro)
                '442;6', // Righteous Bison
                '1101;6', // (B.A.S.E Jumper - Shared - Soldier/Demoman)
                '1153;6', // (Panic Attack - Shared - Soldier/Pyro/Heavy/Engineer)
                '444;6', // Mantreads
                '128;6', // Equalizer                   == Soldier/Melee ==
                '154;6', // (Pain Train - Shared - Soldier/Demoman)
                '357;6', // (Half-Zatoichi - Shared - Soldier/Demoman)
                '416;6', // Market Gardener
                '447;6', // Disciplinary Action
                '775;6', // Escape Plan
                '40;6', // Backburner                   == Pyro/Primary ==
                '215;6', // Degreaser
                '594;6', // Phlogistinator
                '741;6', // Rainblower
                '1178;6', // Dragon's Fury
                '39;6', // Flare Gun                    == Pyro/Secondary ==
                '351;6', // Detonator
                '595;6', // Manmelter
                '740;6', // Scorch Shot
                '1179;6', // Thermal Thruster
                '1180;6', // Gas Passer
                '38;6', // Axtinguisher                 == Pyro/Melee ==
                '153;6', // Homewrecker
                '214;6', // Powerjack
                '326;6', // Back Scratcher
                '348;6', // Sharpened Volcano Fragment
                '457;6', // Postal Pummeler
                '593;6', // Third Degree
                '739;6', // Lollichop
                '813;6', // Neon Annihilator
                '1181;6', // Hot Hand
                '308;6', // Loch-n-Load                 == Demoman/Primary ==
                '405;6', // Ali Baba's Wee Booties
                '608;6', // Bootlegger
                '996;6', // Loose Cannon
                '1151;6', // Iron Bomber
                '130;6', // Scottish Resistance         == Demoman/Secondary ==
                '131;6', // Chargin' Targe
                '265;6', // Sticky Jumper
                '406;6', // Splendid Screen
                '1099;6', // Tide Turner
                '1150;6', // Quickiebomb Launcher
                '132;6', // Eyelander                   == Demoman/Melee ==
                '172;6', // Scotsman's Skullcutter
                '307;6', // Ullapool Caber
                '327;6', // Claidheamh Mòr
                '404;6', // Persian Persuader
                '482;6', // Nessie's Nine Iron
                '609;6', // Scottish Handshake
                '41;6', // Natascha                     == Heavy/Primary ==
                '312;6', // Brass Beast
                '424;6', // Tomislav
                '811;6', // Huo-Long Heater
                '42;6', // Sandvich                     == Heavy/Secondary ==
                '159;6', // Dalokohs Bar
                '311;6', // Buffalo Steak Sandvich
                '425;6', // Family Business
                '1190;6', // Second Banana
                '43;6', // Killing Gloves of Boxing     == Heavy/Melee ==
                '239;6', // Gloves of Running Urgently
                '310;6', // Warrior's Spirit
                '331;6', // Fists of Steel
                '426;6', // Eviction Notice
                '656;6', // Holiday Punch
                '141;6', // Frontier Justice            == Engineer/Primary ==
                '527;6', // Widowmaker
                '588;6', // Pomson 6000
                '997;6', // Rescue Ranger
                '140;6', // Wrangler                    == Engineer/Secondary ==
                '528;6', // Short Circuit
                '142;6', // Gunslinger                  == Engineer/Melee ==
                '155;6', // Southern Hospitality
                '329;6', // Jag
                '589;6', // Eureka Effect
                '36;6', // Blutsauger                   == Medic/Primary ==
                '305;6', // Crusader's Crossbow
                '412;6', // Overdose
                '35;6', // Kritzkrieg                   == Medic/Secondary ==
                '411;6', // Quick-Fix
                '998;6', // Vaccinator
                '37;6', // Ubersaw                      == Medic/Melee ==
                '173;6', // Vita-Saw
                '304;6', // Amputator
                '413;6', // Solemn Vow
                '56;6', // Huntsman                     == Sniper/Primary ==
                '230;6', // Sydney Sleeper
                '402;6', // Bazaar Bargain
                '526;6', // Machina
                '752;6', // Hitman's Heatmaker
                '1092;6', // Fortified Compound
                '1098;6', // Classic
                '57;6', // Razorback                    == Sniper/Secondary ==
                '58;6', // Jarate
                '231;6', // Darwin's Danger Shield
                '642;6', // Cozy Camper
                '751;6', // Cleaner's Carbine
                '171;6', // Tribalman's Shiv            == Sniper/Melee ==
                '232;6', // Bushwacka
                '401;6', // Shahanshah
                '61;6', // Ambassador                   == Spy/Primary ==
                '224;6', // L'Etranger
                '460;6', // Enforcer
                '525;6', // Diamondback
                '225;6', // Your Eternal Reward         == Spy/Melee ==
                '356;6', // Conniver's Kunai
                '461;6', // Big Earner
                '649;6', // Spy-cicle
                '810;6', // Red-Tape Recorder           == Spy/PDA ==
                '60;6', // Cloak and Dagger             == Spy/PDA2 ==
                '59;6', // Dead Ringer
                '939;6' // Bat Outta Hell               == All class/Melee ==
            ],
            uncraft: [
                '61;6;uncraftable',
                '1101;6;uncraftable',
                '226;6;uncraftable',
                '46;6;uncraftable',
                '129;6;uncraftable',
                '311;6;uncraftable',
                '131;6;uncraftable',
                '751;6;uncraftable',
                '354;6;uncraftable',
                '642;6;uncraftable',
                '163;6;uncraftable',
                '159;6;uncraftable',
                '231;6;uncraftable',
                '351;6;uncraftable',
                '525;6;uncraftable',
                '460;6;uncraftable',
                '425;6;uncraftable',
                '39;6;uncraftable',
                '812;6;uncraftable',
                '133;6;uncraftable',
                '58;6;uncraftable',
                '35;6;uncraftable',
                '224;6;uncraftable',
                '222;6;uncraftable',
                '595;6;uncraftable',
                '444;6;uncraftable',
                '773;6;uncraftable',
                '411;6;uncraftable',
                '1150;6;uncraftable',
                '57;6;uncraftable',
                '415;6;uncraftable',
                '442;6;uncraftable',
                '42;6;uncraftable',
                '740;6;uncraftable',
                '130;6;uncraftable',
                '528;6;uncraftable',
                '406;6;uncraftable',
                '265;6;uncraftable',
                '1099;6;uncraftable',
                '998;6;uncraftable',
                '449;6;uncraftable',
                '140;6;uncraftable',
                '1104;6;uncraftable',
                '405;6;uncraftable',
                '772;6;uncraftable',
                '1103;6;uncraftable',
                '40;6;uncraftable',
                '402;6;uncraftable',
                '730;6;uncraftable',
                '228;6;uncraftable',
                '36;6;uncraftable',
                '608;6;uncraftable',
                '312;6;uncraftable',
                '1098;6;uncraftable',
                '441;6;uncraftable',
                '305;6;uncraftable',
                '215;6;uncraftable',
                '127;6;uncraftable',
                '45;6;uncraftable',
                '1092;6;uncraftable',
                '141;6;uncraftable',
                '752;6;uncraftable',
                '56;6;uncraftable',
                '811;6;uncraftable',
                '1151;6;uncraftable',
                '414;6;uncraftable',
                '308;6;uncraftable',
                '996;6;uncraftable',
                '526;6;uncraftable',
                '41;6;uncraftable',
                '513;6;uncraftable',
                '412;6;uncraftable',
                '1153;6;uncraftable',
                '594;6;uncraftable',
                '588;6;uncraftable',
                '741;6;uncraftable',
                '997;6;uncraftable',
                '237;6;uncraftable',
                '220;6;uncraftable',
                '448;6;uncraftable',
                '230;6;uncraftable',
                '424;6;uncraftable',
                '527;6;uncraftable',
                '60;6;uncraftable',
                '59;6;uncraftable',
                '304;6;uncraftable',
                '450;6;uncraftable',
                '38;6;uncraftable',
                '326;6;uncraftable',
                '939;6;uncraftable',
                '461;6;uncraftable',
                '325;6;uncraftable',
                '232;6;uncraftable',
                '317;6;uncraftable',
                '327;6;uncraftable',
                '356;6;uncraftable',
                '447;6;uncraftable',
                '128;6;uncraftable',
                '775;6;uncraftable',
                '589;6;uncraftable',
                '426;6;uncraftable',
                '132;6;uncraftable',
                '355;6;uncraftable',
                '331;6;uncraftable',
                '239;6;uncraftable',
                '142;6;uncraftable',
                '357;6;uncraftable',
                '656;6;uncraftable',
                '221;6;uncraftable',
                '153;6;uncraftable',
                '329;6;uncraftable',
                '43;6;uncraftable',
                '739;6;uncraftable',
                '416;6;uncraftable',
                '813;6;uncraftable',
                '482;6;uncraftable',
                '154;6;uncraftable',
                '404;6;uncraftable',
                '457;6;uncraftable',
                '214;6;uncraftable',
                '44;6;uncraftable',
                '172;6;uncraftable',
                '609;6;uncraftable',
                '401;6;uncraftable',
                '348;6;uncraftable',
                '413;6;uncraftable',
                '155;6;uncraftable',
                '649;6;uncraftable',
                '349;6;uncraftable',
                '593;6;uncraftable',
                '171;6;uncraftable',
                '37;6;uncraftable',
                '307;6;uncraftable',
                '173;6;uncraftable',
                '310;6;uncraftable',
                '648;6;uncraftable',
                '225;6;uncraftable',
                '810;6;uncraftable'
            ]
        };
        return weapons;
    }

    private checkGroupInvites(): void {
        log.debug('Checking group invites');

        for (const groupID64 in this.bot.client.myGroups) {
            if (!Object.prototype.hasOwnProperty.call(this.bot.client.myGroups, groupID64)) {
                continue;
            }

            const relationship = this.bot.client.myGroups[groupID64];

            if (relationship === SteamUser.EClanRelationship.Invited) {
                this.bot.client.respondToGroupInvite(groupID64, false);
            }
        }

        this.groups.forEach(steamID => {
            if (
                this.bot.client.myGroups[steamID] !== SteamUser.EClanRelationship.Member &&
                this.bot.client.myGroups[steamID] !== SteamUser.EClanRelationship.Blocked
            ) {
                this.bot.community.getSteamGroup(new SteamID(steamID), function(err, group) {
                    if (err) {
                        log.warn('Failed to get group: ', err);
                        return;
                    }

                    log.info(`Not member of group ${group.name} ("${steamID}"), joining...`);
                    group.join(function(err) {
                        if (err) {
                            log.warn('Failed to join group: ', err);
                        }
                    });
                });
            }
        });
    }

    onPollData(pollData: PollData): void {
        files.writeFile(paths.files.pollData, pollData, true).catch(function(err) {
            log.warn('Failed to save polldata: ', err);
        });
    }

    onPricelist(pricelist: Entry[]): void {
        log.debug('Pricelist changed');

        if (pricelist.length === 0) {
            // Ignore errors
            this.bot.listings.removeAll().asCallback();
        }

        files
            .writeFile(
                paths.files.pricelist,
                pricelist.map(entry => entry.getJSON()),
                true
            )
            .catch(function(err) {
                log.warn('Failed to save pricelist: ', err);
            });
    }

    onPriceChange(sku: string, entry: Entry): void {
        this.bot.listings.checkBySKU(sku, entry);
    }

    onLoginThrottle(wait: number): void {
        log.warn('Waiting ' + wait + ' ms before trying to sign in...');
    }

    onTF2QueueCompleted(): void {
        log.debug('Queue finished');
        this.bot.client.gamesPlayed([this.customGameName, 440]);
    }
};

function summarizeSteamChat(
    trade: string,
    value: { diff: number; diffRef: number; diffKey: string },
    keyPrice: { buy: Currencies; sell: Currencies }
): string {
    const summary =
        `\n\nSummary\n` +
        trade +
        (value.diff > 0
            ? `\n📈 Profit from overpay: ${value.diffRef} ref` +
              (value.diffRef >= keyPrice.sell.metal ? ` (${value.diffKey})` : '')
            : value.diff < 0
            ? `\n📉 Loss from underpay: ${value.diffRef} ref` +
              (value.diffRef >= keyPrice.sell.metal ? ` (${value.diffKey})` : '')
            : '');
    return summary;
}

function listItems(invalid: string[], overstock: string[], duped: string[], dupedFailed: string[]): string {
    let list = invalid.length !== 0 ? '🟨INVALID_ITEMS:\n- ' + invalid.join(',\n- ') : '';
    list +=
        overstock.length !== 0
            ? (invalid.length !== 0 ? '\n' : '') + '🟦OVERSTOCKED:\n- ' + overstock.join(',\n- ')
            : '';
    list +=
        duped.length !== 0
            ? (invalid.length !== 0 || overstock.length !== 0 ? '\n' : '') + '🟫DUPED_ITEMS:\n- ' + duped.join(',\n- ')
            : '';
    list +=
        dupedFailed.length !== 0
            ? (invalid.length !== 0 || overstock.length !== 0 || duped.length !== 0 ? '\n' : '') +
              '🟪DUPE_CHECK_FAILED:\n- ' +
              dupedFailed.join(',\n- ')
            : '';

    if (list.length === 0) {
        list = '-';
    }
    return list;
}
