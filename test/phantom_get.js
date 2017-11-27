"use strict";

// Only run this code in the PhantomJS environment
if (typeof(phantom)==='object') {
    var page = require('webpage').create();
    var system = require('system');
    var settings = {
        resourceTimeout: 10 * 1000,
    };

    if (system.args.length !== 2) {
        console.log('Opens a web page and prints its content');
        console.log('Usage: phantomjs phantomjs_get.js URL');
        phantom.exit(1);
    } else {
        var url = system.args[1];
        page.open(url, settings, function (status) {
            if (status !== 'success') {
                console.log('Unable to load ' + url);
                phantom.exit(1);
            } else {
                console.log(page.content);
                phantom.exit(0);
            }
        });
    }
}

