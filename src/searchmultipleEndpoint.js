/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2018 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     https://www.zotero.org

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
const Translate = require('./translation/translate');
const TextSearch = require('./textSearch');

const SELECT_TIMEOUT = 60;
const sessionsWaitingForSelection = {};

var requestsSinceGC = 0;

var SearchMultipleEndpoint = module.exports = {
	handle: async function (ctx, next) {
		ctx.assert(ctx.is('text/plain') || ctx.is('json'), 415);

        setTimeout(() => {
            gc();
        });


		var data = ctx.request.body;

		if (!data) {
			ctx.throw(400, "POST data not provided\n");
		}

        // If follow-up request, retrieve session and update context
		var query;
		var session;
		if (typeof data == 'object') {
			let sessionID = data.session;
			if (!sessionID) {
				ctx.throw(400, "'session' not provided");
			}
			session = sessionsWaitingForSelection[sessionID];
			if (session) {
				delete sessionsWaitingForSelection[sessionID];
				session.ctx = ctx;
				session.next = next;
				session.data = data;
			} else {
				let single = !!ctx.request.query.single;
				session = new SearchMultipleSession(ctx, next, data, { single });
			}
		}
		else {
			// Look for DOI, ISBN, etc.
			var identifiers = Zotero.Utilities.extractIdentifiers(data);
			let single = !!ctx.request.query.single;
			session = new SearchMultipleSession(ctx, next, data, { single });
		}

        await session.handleSearchMultiple();

        if (ctx.response.status == 300) {
			if(typeof data == 'object') {
				// Select item if this was an item selection query
				session.data = data;
                await session.handleSearchMultiple();
			} else {
				// Store session if returning multiple choices
				sessionsWaitingForSelection[session.id] = session;
			}
		}
	},


	handleIdentifier: async function (ctx, identifier) {
		// Identifier
		try {
			var translate = new Translate.SearchMultiple();
			translate.setIdentifier(identifier);
			let translators = await translate.getTranslators();
			if (!translators.length) {
				ctx.throw(501, "No translators available", { expose: true });
			}

            translate.setTranslator(translators);

			var items = await translate.translate({
				libraryID: false
			});
		}
		catch (e) {
			if (e == translate.ERROR_NO_RESULTS) {
				ctx.throw(501, e, { expose: true });
			}

			Zotero.debug(e, 1);
			ctx.throw(
				500,
				"An error occurred during translation. "
					+ "Please check translation with the Zotero client.",
				{ expose: true }
			);
		}

		// Translation can return multiple items (e.g., a parent item and notes pointing to it),
		// so we have to return an array with keyed items
		var newItems = [];
		items.forEach(item => {
			newItems.push(...Zotero.Utilities.itemToAPIJSON(item));
		});

		ctx.response.body = newItems;
	}
};

/**
 * Perform garbage collection every 10 requests
 */
function gc() {
    if ((++requestsSinceGC) == 10) {
        for (let i in sessionsWaitingForSelection) {
            let session = sessionsWaitingForSelection[i];
            if (session.started && Date.now() >= session.started + SELECT_TIMEOUT * 1000) {
                delete sessionsWaitingForSelection[i];
            }
        }
        requestsSinceGC = 0;
    }
}



const SearchMultipleSession = require('./searchmultipleSession');
