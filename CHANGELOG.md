0.1.29 / 2018-04-15
===================
- Fix: anonymizeProxy() now supports upstream proxies with empty password

0.1.27 / 2018-03-27
===================
- Added option to create tunnels through http proxies for tcp network connections (eq. connection to mongodb/sql database through http proxy)

0.1.27 / 2018-03-05
===================
- Better error messages for common network errors
- Pass headers from target socket in https tunnel chains

0.1.26 / 2018-02-14
===================
- If connection is denied because of authentication error, optionally "prepareRequestFunction" can provide error message.

0.1.25 / 2018-02-12
===================
- When connection is only through socket, close srcSocket when trgSocket ends

0.1.24 / 2018-02-09
===================
- Fixed incorrect closing of ServerResponse object which caused phantomjs to mark resource requests as errors.

0.1.23 / 2018-02-07
===================
- Fixed missing variable in "Incorrect protocol" error message.

0.1.22 / 2018-02-05
===================
- Renamed project's GitHub organization

0.1.21 / 2018-01-26
===================
- Added Server.getConnectionIds() function

0.1.20 / 2018-01-26
===================
- Fixed "TypeError: The header content contains invalid characters" bug

0.1.19 / 2018-01-25
===================
- fixed uncaught error events, code improved

0.1.18 / 2018-01-25
===================
- fixed a memory leak, improved logging and consolidated code

0.1.17 / 2018-01-23
===================
- added `connectionClosed` event to notify users about closed proxy connections

0.1.16 / 2018-01-09
===================
- added measuring of proxy stats - see `getConnectionStats()` function

0.1.14 / 2017-12-19
===================
- added support for multiple headers with the same name (thx shershennm)

0.0.1 / 2017-11-06
===================
- Project created
