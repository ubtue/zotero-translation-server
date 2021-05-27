/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2018 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     https://www.zotero.org
    Copyright 2021 University Library of Tuebingen

    This file is part of Zotero.

    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.

    ***** END LICENSE BLOCK *****
*/

const config = require('config');
const urlLib = require('url');
const { CONTENT_TYPES } = require('./formats');
const Translate = require('./translation/translate');
const TLDS = Zotero.require('./translation/tlds');
const HTTP = require('./http');
const Translators = require('./translators');
const SearchEndpoint = require('./searchEndpoint');
const { jar: cookieJar } = require('request');
const FORWARDED_HEADERS = ['Accept-Language'];

var SearchMultipleSession = module.exports = function (ctx, next, data, options) {
	this.ctx = ctx;
	this.next = next;
	this.data = data;
	this.options = options;
};

SearchMultipleSession.prototype.handleSearchMultiple = async function () {
    if (typeof this.data == 'object') {
        await this.selectDone();
        return;
    }
    url = this.data;

    // New request
    this._cookieSandbox = cookieJar();

    let resolve;
    let reject;
    let promise = new Promise(function () {
        resolve = arguments[0];
        reject = arguments[1];
    });

    let translate = new Zotero.Translate.SearchMultiple();
    let translatePromise;
        translate.setHandler("translators", async function (translate, translators) {
        try {
            translatePromise = this.translate(translate, translators);
            await translatePromise;
            resolve();
        }
        catch (e) {
            reject(e);
        }
    }.bind(this));
    translate.setHandler("select", (translate, items, callback) => {
        try {
            this.select(
                url,
                translate,
                items,
                callback,
                translatePromise
            );
        }
        catch (e) {
            Zotero.debug(e, 1);
            reject(e);
            // Resolve the translate promise
            callback([]);
            return;
        }
        resolve();
    });

    translate.setCookieSandbox(this._cookieSandbox);
    translate.setIdentifier({'ISSN' :  this.data});
    translate.getTranslators();
    return promise;
};



/**
 * Called when translators are available to perform translation
 *
 * @return {Promise<undefined>}
 */
SearchMultipleSession.prototype.translate = async function (translate, translators) {
	// No matching translators
	if (!translators.length) {
		Zotero.debug("No searchMultiple translators found");
		return;
	}

	var translator;
	var items;
	while (translator = translators.shift()) {
		translate.setTranslator(translator);
		try {

	        //items = await SearchMultipleEndpoint.handleIdentifier(this.ctx, {"ISSN" : this.data});
            items = await translate.translate({
                libraryID: false
            });
			break;
		}
		catch (e) {
			Zotero.debug("Translation using " + translator.label + " failed", 1);
			Zotero.debug(e, 1);

			if (!translators.length) {
				return;
			}

			// Try next translator
		}
	}

	var json = [];
	for (let item of items) {
		json.push(...Zotero.Utilities.itemToAPIJSON(item));
	}
	this.ctx.response.body = json;
};



/**
 * Called if multiple items are available for selection from the translator
 */
SearchMultipleSession.prototype.select = function (url, translate, items, callback, promise) {
	// Fix for translators that return item list as array rather than object
	if (Array.isArray(items)) {
		let newItems = {};
		for (let i = 0; i < items.length; i++) {
			newItems[i] = items[i];
		}
		items = newItems;
	}

	// If translator returns objects with 'title' and 'checked' properties (e.g., PubMed),
	// extract title
	for (let i in items) {
		if (items[i].title) {
			items[i] = items[i].title;
		}
	}

	this.id = Zotero.Utilities.randomString(15);
	this.started = Date.now();
	this.url = url;
	this.translate = translate;
	this.items = items;
	this.selectCallback = callback;
	this.translatePromise = promise;

	// Send "Multiple Choices" HTTP response
	this.ctx.response.status = 300;
	this.ctx.response.body = {
		url,
		session: this.id,
		items
	};
};

/**
 * Called when items have been selected by the client
 */
SearchMultipleSession.prototype.selectDone = function () {
	var url = this.data.url;
	var selectedItems = this.data.items;

	if (this.url != url) {
		this.ctx.throw(409, "'url' \'" + url + "\' does not match URL \'" + this.url + "\' in session");
	}

	if (!selectedItems) {
		this.ctx.throw(400, "'items' not provided");
	}

	// Make sure items are actually available
	var haveItems = false;
	for (let i in selectedItems) {
		if (this.items[i] === undefined || this.items[i] !== selectedItems[i]) {
			this.selectCallback([]);
			this.ctx.throw(409, "Items specified do not match items available");
		}
		haveItems = true;
	}

	// Make sure at least one item was specified
	if (!haveItems) {
		this.selectCallback([]);
		this.ctx.throw(400, "No items specified");
	}

	// Run select callback
	this.selectCallback(selectedItems);

	// The original translate promise in this.translate() from the first request is stalled while
	// waiting for item select from the client. When the follow-up request comes in, the new ctx
	// object is swapped in by the endpoint code, and the select callback above allows the
	// translate promise to complete and the translated items to be assigned to the new ctx
	// response body.
	return this.translatePromise;
};

// Must be included only here to avoid circular dependency problems that lead to empty object
SearchMultipleEndpoint = require('./searchmultipleEndpoint');
