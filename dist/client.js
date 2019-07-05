'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }(); /* eslint-disable camelcase */

var _emailjsBase = require('emailjs-base64');

var _emailjsTcpSocket = require('emailjs-tcp-socket');

var _emailjsTcpSocket2 = _interopRequireDefault(_emailjsTcpSocket);

var _textEncoding = require('text-encoding');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var DEBUG_TAG = 'SMTP Client';

/**
 * Lower Bound for socket timeout to wait since the last data was written to a socket
 */
var TIMEOUT_SOCKET_LOWER_BOUND = 10000;

/**
 * Multiplier for socket timeout:
 *
 * We assume at least a GPRS connection with 115 kb/s = 14,375 kB/s tops, so 10 KB/s to be on
 * the safe side. We can timeout after a lower bound of 10s + (n KB / 10 KB/s). A 1 MB message
 * upload would be 110 seconds to wait for the timeout. 10 KB/s === 0.1 s/B
 */
var TIMEOUT_SOCKET_MULTIPLIER = 0.1;

var SmtpClient = function () {
  /**
   * Creates a connection object to a SMTP server and allows to send mail through it.
   * Call `connect` method to inititate the actual connection, the constructor only
   * defines the properties but does not actually connect.
   *
   * NB! The parameter order (host, port) differs from node.js "way" (port, host)
   *
   * @constructor
   *
   * @param {String} [host="localhost"] Hostname to conenct to
   * @param {Number} [port=25] Port number to connect to
   * @param {Object} [options] Optional options object
   * @param {Boolean} [options.useSecureTransport] Set to true, to use encrypted connection
   * @param {String} [options.name] Client hostname for introducing itself to the server
   * @param {Object} [options.auth] Authentication options. Depends on the preferred authentication method. Usually {user, pass}
   * @param {String} [options.authMethod] Force specific authentication method
   * @param {Boolean} [options.disableEscaping] If set to true, do not escape dots on the beginning of the lines
   * @param {Boolean} [options.logger] A winston-compatible logger
   */
  function SmtpClient(host, port) {
    var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

    _classCallCheck(this, SmtpClient);

    this.options = options;

    this.timeoutSocketLowerBound = TIMEOUT_SOCKET_LOWER_BOUND;
    this.timeoutSocketMultiplier = TIMEOUT_SOCKET_MULTIPLIER;

    this.port = port || (this.options.useSecureTransport ? 465 : 25);
    this.host = host || 'localhost';

    /**
     * If set to true, start an encrypted connection instead of the plaintext one
     * (recommended if applicable). If useSecureTransport is not set but the port used is 465,
     * then ecryption is used by default.
     */
    this.options.useSecureTransport = 'useSecureTransport' in this.options ? !!this.options.useSecureTransport : this.port === 465;

    this.options.auth = this.options.auth || false; // Authentication object. If not set, authentication step will be skipped.
    this.options.name = this.options.name || 'localhost'; // Hostname of the client, this will be used for introducing to the server
    this.socket = false; // Downstream TCP socket to the SMTP server, created with mozTCPSocket
    this.destroyed = false; // Indicates if the connection has been closed and can't be used anymore
    this.waitDrain = false; // Keeps track if the downstream socket is currently full and a drain event should be waited for or not

    // Private properties

    this._authenticatedAs = null; // If authenticated successfully, stores the username
    this._supportedAuth = []; // A list of authentication mechanisms detected from the EHLO response and which are compatible with this library
    this._dataMode = false; // If true, accepts data from the upstream to be passed directly to the downstream socket. Used after the DATA command
    this._lastDataBytes = ''; // Keep track of the last bytes to see how the terminating dot should be placed
    this._envelope = null; // Envelope object for tracking who is sending mail to whom
    this._currentAction = null; // Stores the function that should be run after a response has been received from the server
    this._secureMode = !!this.options.useSecureTransport; // Indicates if the connection is secured or plaintext
    this._socketTimeoutTimer = false; // Timer waiting to declare the socket dead starting from the last write
    this._socketTimeoutStart = false; // Start time of sending the first packet in data mode
    this._socketTimeoutPeriod = false; // Timeout for sending in data mode, gets extended with every send()

    this._parseBlock = { data: [], statusCode: null };
    this._parseRemainder = ''; // If the complete line is not received yet, contains the beginning of it

    var dummyLogger = ['error', 'warning', 'info', 'debug'].reduce(function (o, l) {
      o[l] = function () {};return o;
    }, {});
    this.logger = options.logger || dummyLogger;

    // Event placeholders
    this.onerror = function (e) {}; // Will be run when an error occurs. The `onclose` event will fire subsequently.
    this.ondrain = function () {}; // More data can be buffered in the socket.
    this.onclose = function () {}; // The connection to the server has been closed
    this.onidle = function () {}; // The connection is established and idle, you can send mail now
    this.onready = function (failedRecipients) {}; // Waiting for mail body, lists addresses that were not accepted as recipients
    this.ondone = function (success) {}; // The mail has been sent. Wait for `onidle` next. Indicates if the message was queued by the server.
  }

  /**
   * Initiate a connection to the server
   */


  _createClass(SmtpClient, [{
    key: 'connect',
    value: function connect() {
      var _this = this;

      var SocketContructor = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : _emailjsTcpSocket2.default;

      this.socket = SocketContructor.open(this.host, this.port, {
        binaryType: 'arraybuffer',
        useSecureTransport: this._secureMode,
        ca: this.options.ca,
        tlsWorkerPath: this.options.tlsWorkerPath,
        ws: this.options.ws
      });

      // allows certificate handling for platform w/o native tls support
      // oncert is non standard so setting it might throw if the socket object is immutable
      try {
        this.socket.oncert = function (cert) {
          _this.oncert && _this.oncert(cert);
        };
      } catch (E) {}
      this.socket.onerror = this._onError.bind(this);
      this.socket.onopen = this._onOpen.bind(this);
    }

    /**
     * Sends QUIT
     */

  }, {
    key: 'quit',
    value: function quit() {
      this.logger.debug(DEBUG_TAG, 'Sending QUIT...');
      this._sendCommand('QUIT');
      this._currentAction = this.close;
    }

    /**
     * Closes the connection to the server
     */

  }, {
    key: 'close',
    value: function close() {
      this.logger.debug(DEBUG_TAG, 'Closing connection...');
      if (this.socket && this.socket.readyState === 'open') {
        this.socket.close();
      } else {
        this._destroy();
      }
    }

    // Mail related methods

    /**
     * Initiates a new message by submitting envelope data, starting with
     * `MAIL FROM:` command. Use after `onidle` event
     *
     * @param {Object} envelope Envelope object in the form of {from:"...", to:["..."]}
     */

  }, {
    key: 'useEnvelope',
    value: function useEnvelope(envelope) {
      this._envelope = envelope || {};
      this._envelope.from = [].concat(this._envelope.from || 'anonymous@' + this.options.name)[0];
      this._envelope.to = [].concat(this._envelope.to || []);

      // clone the recipients array for latter manipulation
      this._envelope.rcptQueue = [].concat(this._envelope.to);
      this._envelope.rcptFailed = [];
      this._envelope.responseQueue = [];

      this._currentAction = this._actionMAIL;
      this.logger.debug(DEBUG_TAG, 'Sending MAIL FROM...');
      this._sendCommand('MAIL FROM:<' + this._envelope.from + '>');
    }

    /**
     * Send ASCII data to the server. Works only in data mode (after `onready` event), ignored
     * otherwise
     *
     * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
     * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
     */

  }, {
    key: 'send',
    value: function send(chunk) {
      // works only in data mode
      if (!this._dataMode) {
        // this line should never be reached but if it does,
        // act like everything's normal.
        return true;
      }

      // TODO: if the chunk is an arraybuffer, use a separate function to send the data
      return this._sendString(chunk);
    }

    /**
     * Indicates that a data stream for the socket is ended. Works only in data
     * mode (after `onready` event), ignored otherwise. Use it when you are done
     * with sending the mail. This method does not close the socket. Once the mail
     * has been queued by the server, `ondone` and `onidle` are emitted.
     *
     * @param {Buffer} [chunk] Chunk of data to be sent to the server
     */

  }, {
    key: 'end',
    value: function end(chunk) {
      // works only in data mode
      if (!this._dataMode) {
        // this line should never be reached but if it does,
        // act like everything's normal.
        return true;
      }

      if (chunk && chunk.length) {
        this.send(chunk);
      }

      // redirect output from the server to _actionStream
      this._currentAction = this._actionStream;

      // indicate that the stream has ended by sending a single dot on its own line
      // if the client already closed the data with \r\n no need to do it again
      if (this._lastDataBytes === '\r\n') {
        this.waitDrain = this._send(new Uint8Array([0x2E, 0x0D, 0x0A]).buffer); // .\r\n
      } else if (this._lastDataBytes.substr(-1) === '\r') {
        this.waitDrain = this._send(new Uint8Array([0x0A, 0x2E, 0x0D, 0x0A]).buffer); // \n.\r\n
      } else {
        this.waitDrain = this._send(new Uint8Array([0x0D, 0x0A, 0x2E, 0x0D, 0x0A]).buffer); // \r\n.\r\n
      }

      // end data mode, reset the variables for extending the timeout in data mode
      this._dataMode = false;
      this._socketTimeoutStart = false;
      this._socketTimeoutPeriod = false;

      return this.waitDrain;
    }

    // PRIVATE METHODS

    /**
     * Queue some data from the server for parsing.
     *
     * @param {String} chunk Chunk of data received from the server
     */

  }, {
    key: '_parse',
    value: function _parse(chunk) {
      // Lines should always end with <CR><LF> but you never know, might be only <LF> as well
      var lines = (this._parseRemainder + (chunk || '')).split(/\r?\n/);
      this._parseRemainder = lines.pop(); // not sure if the line has completely arrived yet

      for (var i = 0, len = lines.length; i < len; i++) {
        if (!lines[i].trim()) {
          // nothing to check, empty line
          continue;
        }

        // possible input strings for the regex:
        // 250-MULTILINE REPLY
        // 250 LAST LINE OF REPLY
        // 250 1.2.3 MESSAGE

        var match = lines[i].match(/^(\d{3})([- ])(?:(\d+\.\d+\.\d+)(?: ))?(.*)/);

        if (match) {
          this._parseBlock.data.push(match[4]);

          if (match[2] === '-') {
            // this is a multiline reply
            this._parseBlock.statusCode = this._parseBlock.statusCode || Number(match[1]);
          } else {
            var statusCode = Number(match[1]) || 0;
            var response = {
              statusCode: statusCode,
              data: this._parseBlock.data.join('\n'),
              success: statusCode >= 200 && statusCode < 300
            };

            this._onCommand(response);
            this._parseBlock = {
              data: [],
              statusCode: null
            };
          }
        } else {
          this._onCommand({
            success: false,
            statusCode: this._parseBlock.statusCode || null,
            data: [lines[i]].join('\n')
          });
          this._parseBlock = {
            data: [],
            statusCode: null
          };
        }
      }
    }

    // EVENT HANDLERS FOR THE SOCKET

    /**
     * Connection listener that is run when the connection to the server is opened.
     * Sets up different event handlers for the opened socket
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onOpen',
    value: function _onOpen(event) {
      if (event && event.data && event.data.proxyHostname) {
        this.options.name = event.data.proxyHostname;
      }

      this.socket.ondata = this._onData.bind(this);

      this.socket.onclose = this._onClose.bind(this);
      this.socket.ondrain = this._onDrain.bind(this);

      this._currentAction = this._actionGreeting;
    }

    /**
     * Data listener for chunks of data emitted by the server
     *
     * @event
     * @param {Event} evt Event object. See `evt.data` for the chunk received
     */

  }, {
    key: '_onData',
    value: function _onData(evt) {
      clearTimeout(this._socketTimeoutTimer);
      var stringPayload = new _textEncoding.TextDecoder('UTF-8').decode(new Uint8Array(evt.data));
      this.logger.debug(DEBUG_TAG, 'SERVER: ' + stringPayload);
      this._parse(stringPayload);
    }

    /**
     * More data can be buffered in the socket, `waitDrain` is reset to false
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onDrain',
    value: function _onDrain() {
      this.waitDrain = false;
      this.ondrain();
    }

    /**
     * Error handler for the socket
     *
     * @event
     * @param {Event} evt Event object. See evt.data for the error
     */

  }, {
    key: '_onError',
    value: function _onError(evt) {
      if (evt instanceof Error && evt.message) {
        this.logger.error(DEBUG_TAG, evt);
        this.onerror(evt);
      } else if (evt && evt.data instanceof Error) {
        this.logger.error(DEBUG_TAG, evt.data);
        this.onerror(evt.data);
      } else {
        this.logger.error(DEBUG_TAG, new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
        this.onerror(new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
      }

      this.close();
    }

    /**
     * Indicates that the socket has been closed
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onClose',
    value: function _onClose() {
      this.logger.debug(DEBUG_TAG, 'Socket closed.');
      this._destroy();
    }

    /**
     * This is not a socket data handler but the handler for data emitted by the parser,
     * so this data is safe to use as it is always complete (server might send partial chunks)
     *
     * @event
     * @param {Object} command Parsed data
     */

  }, {
    key: '_onCommand',
    value: function _onCommand(command) {
      if (typeof this._currentAction === 'function') {
        this._currentAction(command);
      }
    }
  }, {
    key: '_onTimeout',
    value: function _onTimeout() {
      // inform about the timeout and shut down
      var error = new Error('Socket timed out!');
      this._onError(error);
    }

    /**
     * Ensures that the connection is closed and such
     */

  }, {
    key: '_destroy',
    value: function _destroy() {
      clearTimeout(this._socketTimeoutTimer);

      if (!this.destroyed) {
        this.destroyed = true;
        this.onclose();
      }
    }

    /**
     * Sends a string to the socket.
     *
     * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
     * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
     */

  }, {
    key: '_sendString',
    value: function _sendString(chunk) {
      // escape dots
      if (!this.options.disableEscaping) {
        chunk = chunk.replace(/\n\./g, '\n..');
        if ((this._lastDataBytes.substr(-1) === '\n' || !this._lastDataBytes) && chunk.charAt(0) === '.') {
          chunk = '.' + chunk;
        }
      }

      // Keeping eye on the last bytes sent, to see if there is a <CR><LF> sequence
      // at the end which is needed to end the data stream
      if (chunk.length > 2) {
        this._lastDataBytes = chunk.substr(-2);
      } else if (chunk.length === 1) {
        this._lastDataBytes = this._lastDataBytes.substr(-1) + chunk;
      }

      this.logger.debug(DEBUG_TAG, 'Sending ' + chunk.length + ' bytes of payload');

      // pass the chunk to the socket
      this.waitDrain = this._send(new _textEncoding.TextEncoder('UTF-8').encode(chunk).buffer);
      return this.waitDrain;
    }

    /**
     * Send a string command to the server, also append \r\n if needed
     *
     * @param {String} str String to be sent to the server
     */

  }, {
    key: '_sendCommand',
    value: function _sendCommand(str) {
      this.waitDrain = this._send(new _textEncoding.TextEncoder('UTF-8').encode(str + (str.substr(-2) !== '\r\n' ? '\r\n' : '')).buffer);
    }
  }, {
    key: '_send',
    value: function _send(buffer) {
      this._setTimeout(buffer.byteLength);
      return this.socket.send(buffer);
    }
  }, {
    key: '_setTimeout',
    value: function _setTimeout(byteLength) {
      var prolongPeriod = Math.floor(byteLength * this.timeoutSocketMultiplier);
      var timeout;

      if (this._dataMode) {
        // we're in data mode, so we count only one timeout that get extended for every send().
        var now = Date.now();

        // the old timeout start time
        this._socketTimeoutStart = this._socketTimeoutStart || now;

        // the old timeout period, normalized to a minimum of TIMEOUT_SOCKET_LOWER_BOUND
        this._socketTimeoutPeriod = (this._socketTimeoutPeriod || this.timeoutSocketLowerBound) + prolongPeriod;

        // the new timeout is the delta between the new firing time (= timeout period + timeout start time) and now
        timeout = this._socketTimeoutStart + this._socketTimeoutPeriod - now;
      } else {
        // set new timout
        timeout = this.timeoutSocketLowerBound + prolongPeriod;
      }

      clearTimeout(this._socketTimeoutTimer); // clear pending timeouts
      this._socketTimeoutTimer = setTimeout(this._onTimeout.bind(this), timeout); // arm the next timeout
    }

    /**
     * Intitiate authentication sequence if needed
     */

  }, {
    key: '_authenticateUser',
    value: function _authenticateUser() {
      if (!this.options.auth) {
        // no need to authenticate, at least no data given
        this._currentAction = this._actionIdle;
        this.onidle(); // ready to take orders
        return;
      }

      var auth;

      if (!this.options.authMethod && this.options.auth.xoauth2) {
        this.options.authMethod = 'XOAUTH2';
      }

      if (this.options.authMethod) {
        auth = this.options.authMethod.toUpperCase().trim();
      } else {
        // use first supported
        auth = (this._supportedAuth[0] || 'PLAIN').toUpperCase().trim();
      }

      switch (auth) {
        case 'LOGIN':
          // LOGIN is a 3 step authentication process
          // C: AUTH LOGIN
          // C: BASE64(USER)
          // C: BASE64(PASS)
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH LOGIN');
          this._currentAction = this._actionAUTH_LOGIN_USER;
          this._sendCommand('AUTH LOGIN');
          return;
        case 'PLAIN':
          // AUTH PLAIN is a 1 step authentication process
          // C: AUTH PLAIN BASE64(\0 USER \0 PASS)
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH PLAIN');
          this._currentAction = this._actionAUTHComplete;
          this._sendCommand(
          // convert to BASE64
          'AUTH PLAIN ' + (0, _emailjsBase.encode)(
          // this.options.auth.user+'\u0000'+
          '\0' + // skip authorization identity as it causes problems with some servers
          this.options.auth.user + '\0' + this.options.auth.pass));
          return;
        case 'XOAUTH2':
          // See https://developers.google.com/gmail/xoauth2_protocol#smtp_protocol_exchange
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH XOAUTH2');
          this._currentAction = this._actionAUTH_XOAUTH2;
          this._sendCommand('AUTH XOAUTH2 ' + this._buildXOAuth2Token(this.options.auth.user, this.options.auth.xoauth2));
          return;
      }

      this._onError(new Error('Unknown authentication method ' + auth));
    }

    // ACTIONS FOR RESPONSES FROM THE SMTP SERVER

    /**
     * Initial response from the server, must have a status 220
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionGreeting',
    value: function _actionGreeting(command) {
      if (command.statusCode !== 220) {
        this._onError(new Error('Invalid greeting: ' + command.data));
        return;
      }

      if (this.options.lmtp) {
        this.logger.debug(DEBUG_TAG, 'Sending LHLO ' + this.options.name);

        this._currentAction = this._actionLHLO;
        this._sendCommand('LHLO ' + this.options.name);
      } else {
        this.logger.debug(DEBUG_TAG, 'Sending EHLO ' + this.options.name);

        this._currentAction = this._actionEHLO;
        this._sendCommand('EHLO ' + this.options.name);
      }
    }

    /**
     * Response to LHLO
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionLHLO',
    value: function _actionLHLO(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'LHLO not successful');
        this._onError(new Error(command.data));
        return;
      }

      // Process as EHLO response
      this._actionEHLO(command);
    }

    /**
     * Response to EHLO. If the response is an error, try HELO instead
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionEHLO',
    value: function _actionEHLO(command) {
      var match;

      if (!command.success) {
        if (!this._secureMode && this.options.requireTLS) {
          var errMsg = 'STARTTLS not supported without EHLO';
          this.logger.error(DEBUG_TAG, errMsg);
          this._onError(new Error(errMsg));
          return;
        }

        // Try HELO instead
        this.logger.warning(DEBUG_TAG, 'EHLO not successful, trying HELO ' + this.options.name);
        this._currentAction = this._actionHELO;
        this._sendCommand('HELO ' + this.options.name);
        return;
      }

      // Detect if the server supports PLAIN auth
      if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)PLAIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH PLAIN');
        this._supportedAuth.push('PLAIN');
      }

      // Detect if the server supports LOGIN auth
      if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)LOGIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH LOGIN');
        this._supportedAuth.push('LOGIN');
      }

      // Detect if the server supports XOAUTH2 auth
      if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)XOAUTH2/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH XOAUTH2');
        this._supportedAuth.push('XOAUTH2');
      }

      // Detect maximum allowed message size
      if ((match = command.data.match(/SIZE (\d+)/i)) && Number(match[1])) {
        var maxAllowedSize = Number(match[1]);
        this.logger.debug(DEBUG_TAG, 'Maximum allowd message size: ' + maxAllowedSize);
      }

      // Detect if the server supports STARTTLS
      if (!this._secureMode) {
        if (command.data.match(/STARTTLS\s?$/mi) && !this.options.ignoreTLS || !!this.options.requireTLS) {
          this._currentAction = this._actionSTARTTLS;
          this.logger.debug(DEBUG_TAG, 'Sending STARTTLS');
          this._sendCommand('STARTTLS');
          return;
        }
      }

      this._authenticateUser();
    }

    /**
     * Handles server response for STARTTLS command. If there's an error
     * try HELO instead, otherwise initiate TLS upgrade. If the upgrade
     * succeedes restart the EHLO
     *
     * @param {String} str Message from the server
     */

  }, {
    key: '_actionSTARTTLS',
    value: function _actionSTARTTLS(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'STARTTLS not successful');
        this._onError(new Error(command.data));
        return;
      }

      this._secureMode = true;
      this.socket.upgradeToSecure();

      // restart protocol flow
      this._currentAction = this._actionEHLO;
      this._sendCommand('EHLO ' + this.options.name);
    }

    /**
     * Response to HELO
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionHELO',
    value: function _actionHELO(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'HELO not successful');
        this._onError(new Error(command.data));
        return;
      }
      this._authenticateUser();
    }

    /**
     * Response to AUTH LOGIN, if successful expects base64 encoded username
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionAUTH_LOGIN_USER',
    value: function _actionAUTH_LOGIN_USER(command) {
      if (command.statusCode !== 334 || command.data !== 'VXNlcm5hbWU6') {
        this.logger.error(DEBUG_TAG, 'AUTH LOGIN USER not successful: ' + command.data);
        this._onError(new Error('Invalid login sequence while waiting for "334 VXNlcm5hbWU6 ": ' + command.data));
        return;
      }
      this.logger.debug(DEBUG_TAG, 'AUTH LOGIN USER successful');
      this._currentAction = this._actionAUTH_LOGIN_PASS;
      this._sendCommand((0, _emailjsBase.encode)(this.options.auth.user));
    }

    /**
     * Response to AUTH LOGIN username, if successful expects base64 encoded password
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionAUTH_LOGIN_PASS',
    value: function _actionAUTH_LOGIN_PASS(command) {
      if (command.statusCode !== 334 || command.data !== 'UGFzc3dvcmQ6') {
        this.logger.error(DEBUG_TAG, 'AUTH LOGIN PASS not successful: ' + command.data);
        this._onError(new Error('Invalid login sequence while waiting for "334 UGFzc3dvcmQ6 ": ' + command.data));
        return;
      }
      this.logger.debug(DEBUG_TAG, 'AUTH LOGIN PASS successful');
      this._currentAction = this._actionAUTHComplete;
      this._sendCommand((0, _emailjsBase.encode)(this.options.auth.pass));
    }

    /**
     * Response to AUTH XOAUTH2 token, if error occurs send empty response
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionAUTH_XOAUTH2',
    value: function _actionAUTH_XOAUTH2(command) {
      if (!command.success) {
        this.logger.warning(DEBUG_TAG, 'Error during AUTH XOAUTH2, sending empty response');
        this._sendCommand('');
        this._currentAction = this._actionAUTHComplete;
      } else {
        this._actionAUTHComplete(command);
      }
    }

    /**
     * Checks if authentication succeeded or not. If successfully authenticated
     * emit `idle` to indicate that an e-mail can be sent using this connection
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionAUTHComplete',
    value: function _actionAUTHComplete(command) {
      if (!command.success) {
        this.logger.debug(DEBUG_TAG, 'Authentication failed: ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this.logger.debug(DEBUG_TAG, 'Authentication successful.');

      this._authenticatedAs = this.options.auth.user;

      this._currentAction = this._actionIdle;
      this.onidle(); // ready to take orders
    }

    /**
     * Used when the connection is idle and the server emits timeout
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionIdle',
    value: function _actionIdle(command) {
      if (command.statusCode > 300) {
        this._onError(new Error(command.data));
        return;
      }

      this._onError(new Error(command.data));
    }

    /**
     * Response to MAIL FROM command. Proceed to defining RCPT TO list if successful
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionMAIL',
    value: function _actionMAIL(command) {
      if (!command.success) {
        this.logger.debug(DEBUG_TAG, 'MAIL FROM unsuccessful: ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      if (!this._envelope.rcptQueue.length) {
        this._onError(new Error('Can\'t send mail - no recipients defined'));
      } else {
        this.logger.debug(DEBUG_TAG, 'MAIL FROM successful, proceeding with ' + this._envelope.rcptQueue.length + ' recipients');
        this.logger.debug(DEBUG_TAG, 'Adding recipient...');
        this._envelope.curRecipient = this._envelope.rcptQueue.shift();
        this._currentAction = this._actionRCPT;
        this._sendCommand('RCPT TO:<' + this._envelope.curRecipient + '>');
      }
    }

    /**
     * Response to a RCPT TO command. If the command is unsuccessful, try the next one,
     * as this might be related only to the current recipient, not a global error, so
     * the following recipients might still be valid
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionRCPT',
    value: function _actionRCPT(command) {
      if (!command.success) {
        this.logger.warning(DEBUG_TAG, 'RCPT TO failed for: ' + this._envelope.curRecipient);
        // this is a soft error
        this._envelope.rcptFailed.push(this._envelope.curRecipient);
      } else {
        this._envelope.responseQueue.push(this._envelope.curRecipient);
      }

      if (!this._envelope.rcptQueue.length) {
        if (this._envelope.rcptFailed.length < this._envelope.to.length) {
          this._currentAction = this._actionDATA;
          this.logger.debug(DEBUG_TAG, 'RCPT TO done, proceeding with payload');
          this._sendCommand('DATA');
        } else {
          this._onError(new Error('Can\'t send mail - all recipients were rejected'));
          this._currentAction = this._actionIdle;
        }
      } else {
        this.logger.debug(DEBUG_TAG, 'Adding recipient...');
        this._envelope.curRecipient = this._envelope.rcptQueue.shift();
        this._currentAction = this._actionRCPT;
        this._sendCommand('RCPT TO:<' + this._envelope.curRecipient + '>');
      }
    }

    /**
     * Response to the DATA command. Server is now waiting for a message, so emit `onready`
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionDATA',
    value: function _actionDATA(command) {
      // response should be 354 but according to this issue https://github.com/eleith/emailjs/issues/24
      // some servers might use 250 instead
      if ([250, 354].indexOf(command.statusCode) < 0) {
        this.logger.error(DEBUG_TAG, 'DATA unsuccessful ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this._dataMode = true;
      this._currentAction = this._actionIdle;
      this.onready(this._envelope.rcptFailed);
    }

    /**
     * Response from the server, once the message stream has ended with <CR><LF>.<CR><LF>
     * Emits `ondone`.
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionStream',
    value: function _actionStream(command) {
      var rcpt;

      if (this.options.lmtp) {
        // LMTP returns a response code for *every* successfully set recipient
        // For every recipient the message might succeed or fail individually

        rcpt = this._envelope.responseQueue.shift();
        if (!command.success) {
          this.logger.error(DEBUG_TAG, 'Local delivery to ' + rcpt + ' failed.');
          this._envelope.rcptFailed.push(rcpt);
        } else {
          this.logger.error(DEBUG_TAG, 'Local delivery to ' + rcpt + ' succeeded.');
        }

        if (this._envelope.responseQueue.length) {
          this._currentAction = this._actionStream;
          return;
        }

        this._currentAction = this._actionIdle;
        this.ondone(true);
      } else {
        // For SMTP the message either fails or succeeds, there is no information
        // about individual recipients

        if (!command.success) {
          this.logger.error(DEBUG_TAG, 'Message sending failed.');
        } else {
          this.logger.debug(DEBUG_TAG, 'Message sent successfully.');
        }

        this._currentAction = this._actionIdle;
        this.ondone(!!command.success);
      }

      // If the client wanted to do something else (eg. to quit), do not force idle
      if (this._currentAction === this._actionIdle) {
        // Waiting for new connections
        this.logger.debug(DEBUG_TAG, 'Idling while waiting for new connections...');
        this.onidle();
      }
    }

    /**
     * Builds a login token for XOAUTH2 authentication command
     *
     * @param {String} user E-mail address of the user
     * @param {String} token Valid access token for the user
     * @return {String} Base64 formatted login token
     */

  }, {
    key: '_buildXOAuth2Token',
    value: function _buildXOAuth2Token(user, token) {
      var authData = ['user=' + (user || ''), 'auth=Bearer ' + token, '', ''];
      // base64("user={User}\x00auth=Bearer {Token}\x00\x00")
      return (0, _emailjsBase.encode)(authData.join('\x01'));
    }
  }]);

  return SmtpClient;
}();

exports.default = SmtpClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9hdXRoZW50aWNhdGVkQXMiLCJfc3VwcG9ydGVkQXV0aCIsIl9kYXRhTW9kZSIsIl9sYXN0RGF0YUJ5dGVzIiwiX2VudmVsb3BlIiwiX2N1cnJlbnRBY3Rpb24iLCJfc2VjdXJlTW9kZSIsIl9zb2NrZXRUaW1lb3V0VGltZXIiLCJfc29ja2V0VGltZW91dFN0YXJ0IiwiX3NvY2tldFRpbWVvdXRQZXJpb2QiLCJfcGFyc2VCbG9jayIsImRhdGEiLCJzdGF0dXNDb2RlIiwiX3BhcnNlUmVtYWluZGVyIiwiZHVtbXlMb2dnZXIiLCJyZWR1Y2UiLCJvIiwibCIsImxvZ2dlciIsIm9uZXJyb3IiLCJlIiwib25kcmFpbiIsIm9uY2xvc2UiLCJvbmlkbGUiLCJvbnJlYWR5IiwiZmFpbGVkUmVjaXBpZW50cyIsIm9uZG9uZSIsInN1Y2Nlc3MiLCJTb2NrZXRDb250cnVjdG9yIiwiVENQU29ja2V0Iiwib3BlbiIsImJpbmFyeVR5cGUiLCJjYSIsInRsc1dvcmtlclBhdGgiLCJ3cyIsIm9uY2VydCIsImNlcnQiLCJFIiwiX29uRXJyb3IiLCJiaW5kIiwib25vcGVuIiwiX29uT3BlbiIsImRlYnVnIiwiX3NlbmRDb21tYW5kIiwiY2xvc2UiLCJyZWFkeVN0YXRlIiwiX2Rlc3Ryb3kiLCJlbnZlbG9wZSIsImZyb20iLCJjb25jYXQiLCJ0byIsInJjcHRRdWV1ZSIsInJjcHRGYWlsZWQiLCJyZXNwb25zZVF1ZXVlIiwiX2FjdGlvbk1BSUwiLCJjaHVuayIsIl9zZW5kU3RyaW5nIiwibGVuZ3RoIiwic2VuZCIsIl9hY3Rpb25TdHJlYW0iLCJfc2VuZCIsIlVpbnQ4QXJyYXkiLCJidWZmZXIiLCJzdWJzdHIiLCJsaW5lcyIsInNwbGl0IiwicG9wIiwiaSIsImxlbiIsInRyaW0iLCJtYXRjaCIsInB1c2giLCJOdW1iZXIiLCJyZXNwb25zZSIsImpvaW4iLCJfb25Db21tYW5kIiwiZXZlbnQiLCJwcm94eUhvc3RuYW1lIiwib25kYXRhIiwiX29uRGF0YSIsIl9vbkNsb3NlIiwiX29uRHJhaW4iLCJfYWN0aW9uR3JlZXRpbmciLCJldnQiLCJjbGVhclRpbWVvdXQiLCJzdHJpbmdQYXlsb2FkIiwiVGV4dERlY29kZXIiLCJkZWNvZGUiLCJfcGFyc2UiLCJFcnJvciIsIm1lc3NhZ2UiLCJlcnJvciIsImNvbW1hbmQiLCJkaXNhYmxlRXNjYXBpbmciLCJyZXBsYWNlIiwiY2hhckF0IiwiVGV4dEVuY29kZXIiLCJlbmNvZGUiLCJzdHIiLCJfc2V0VGltZW91dCIsImJ5dGVMZW5ndGgiLCJwcm9sb25nUGVyaW9kIiwiTWF0aCIsImZsb29yIiwidGltZW91dCIsIm5vdyIsIkRhdGUiLCJzZXRUaW1lb3V0IiwiX29uVGltZW91dCIsIl9hY3Rpb25JZGxlIiwiYXV0aE1ldGhvZCIsInhvYXV0aDIiLCJ0b1VwcGVyQ2FzZSIsIl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIiLCJfYWN0aW9uQVVUSENvbXBsZXRlIiwidXNlciIsInBhc3MiLCJfYWN0aW9uQVVUSF9YT0FVVEgyIiwiX2J1aWxkWE9BdXRoMlRva2VuIiwibG10cCIsIl9hY3Rpb25MSExPIiwiX2FjdGlvbkVITE8iLCJyZXF1aXJlVExTIiwiZXJyTXNnIiwid2FybmluZyIsIl9hY3Rpb25IRUxPIiwibWF4QWxsb3dlZFNpemUiLCJpZ25vcmVUTFMiLCJfYWN0aW9uU1RBUlRUTFMiLCJfYXV0aGVudGljYXRlVXNlciIsInVwZ3JhZGVUb1NlY3VyZSIsIl9hY3Rpb25BVVRIX0xPR0lOX1BBU1MiLCJjdXJSZWNpcGllbnQiLCJzaGlmdCIsIl9hY3Rpb25SQ1BUIiwiX2FjdGlvbkRBVEEiLCJpbmRleE9mIiwicmNwdCIsInRva2VuIiwiYXV0aERhdGEiXSwibWFwcGluZ3MiOiI7Ozs7OztxakJBQUE7O0FBRUE7O0FBQ0E7Ozs7QUFDQTs7Ozs7O0FBRUEsSUFBSUEsWUFBWSxhQUFoQjs7QUFFQTs7O0FBR0EsSUFBTUMsNkJBQTZCLEtBQW5DOztBQUVBOzs7Ozs7O0FBT0EsSUFBTUMsNEJBQTRCLEdBQWxDOztJQUVNQyxVO0FBQ0o7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFtQkEsc0JBQWFDLElBQWIsRUFBbUJDLElBQW5CLEVBQXVDO0FBQUEsUUFBZEMsT0FBYyx1RUFBSixFQUFJOztBQUFBOztBQUNyQyxTQUFLQSxPQUFMLEdBQWVBLE9BQWY7O0FBRUEsU0FBS0MsdUJBQUwsR0FBK0JOLDBCQUEvQjtBQUNBLFNBQUtPLHVCQUFMLEdBQStCTix5QkFBL0I7O0FBRUEsU0FBS0csSUFBTCxHQUFZQSxTQUFTLEtBQUtDLE9BQUwsQ0FBYUcsa0JBQWIsR0FBa0MsR0FBbEMsR0FBd0MsRUFBakQsQ0FBWjtBQUNBLFNBQUtMLElBQUwsR0FBWUEsUUFBUSxXQUFwQjs7QUFFQTs7Ozs7QUFLQSxTQUFLRSxPQUFMLENBQWFHLGtCQUFiLEdBQWtDLHdCQUF3QixLQUFLSCxPQUE3QixHQUF1QyxDQUFDLENBQUMsS0FBS0EsT0FBTCxDQUFhRyxrQkFBdEQsR0FBMkUsS0FBS0osSUFBTCxLQUFjLEdBQTNIOztBQUVBLFNBQUtDLE9BQUwsQ0FBYUksSUFBYixHQUFvQixLQUFLSixPQUFMLENBQWFJLElBQWIsSUFBcUIsS0FBekMsQ0FoQnFDLENBZ0JVO0FBQy9DLFNBQUtKLE9BQUwsQ0FBYUssSUFBYixHQUFvQixLQUFLTCxPQUFMLENBQWFLLElBQWIsSUFBcUIsV0FBekMsQ0FqQnFDLENBaUJnQjtBQUNyRCxTQUFLQyxNQUFMLEdBQWMsS0FBZCxDQWxCcUMsQ0FrQmpCO0FBQ3BCLFNBQUtDLFNBQUwsR0FBaUIsS0FBakIsQ0FuQnFDLENBbUJkO0FBQ3ZCLFNBQUtDLFNBQUwsR0FBaUIsS0FBakIsQ0FwQnFDLENBb0JkOztBQUV2Qjs7QUFFQSxTQUFLQyxnQkFBTCxHQUF3QixJQUF4QixDQXhCcUMsQ0F3QlI7QUFDN0IsU0FBS0MsY0FBTCxHQUFzQixFQUF0QixDQXpCcUMsQ0F5Qlo7QUFDekIsU0FBS0MsU0FBTCxHQUFpQixLQUFqQixDQTFCcUMsQ0EwQmQ7QUFDdkIsU0FBS0MsY0FBTCxHQUFzQixFQUF0QixDQTNCcUMsQ0EyQlo7QUFDekIsU0FBS0MsU0FBTCxHQUFpQixJQUFqQixDQTVCcUMsQ0E0QmY7QUFDdEIsU0FBS0MsY0FBTCxHQUFzQixJQUF0QixDQTdCcUMsQ0E2QlY7QUFDM0IsU0FBS0MsV0FBTCxHQUFtQixDQUFDLENBQUMsS0FBS2YsT0FBTCxDQUFhRyxrQkFBbEMsQ0E5QnFDLENBOEJnQjtBQUNyRCxTQUFLYSxtQkFBTCxHQUEyQixLQUEzQixDQS9CcUMsQ0ErQko7QUFDakMsU0FBS0MsbUJBQUwsR0FBMkIsS0FBM0IsQ0FoQ3FDLENBZ0NKO0FBQ2pDLFNBQUtDLG9CQUFMLEdBQTRCLEtBQTVCLENBakNxQyxDQWlDSDs7QUFFbEMsU0FBS0MsV0FBTCxHQUFtQixFQUFFQyxNQUFNLEVBQVIsRUFBWUMsWUFBWSxJQUF4QixFQUFuQjtBQUNBLFNBQUtDLGVBQUwsR0FBdUIsRUFBdkIsQ0FwQ3FDLENBb0NYOztBQUUxQixRQUFNQyxjQUFjLENBQUMsT0FBRCxFQUFVLFNBQVYsRUFBcUIsTUFBckIsRUFBNkIsT0FBN0IsRUFBc0NDLE1BQXRDLENBQTZDLFVBQUNDLENBQUQsRUFBSUMsQ0FBSixFQUFVO0FBQUVELFFBQUVDLENBQUYsSUFBTyxZQUFNLENBQUUsQ0FBZixDQUFpQixPQUFPRCxDQUFQO0FBQVUsS0FBcEYsRUFBc0YsRUFBdEYsQ0FBcEI7QUFDQSxTQUFLRSxNQUFMLEdBQWMzQixRQUFRMkIsTUFBUixJQUFrQkosV0FBaEM7O0FBRUE7QUFDQSxTQUFLSyxPQUFMLEdBQWUsVUFBQ0MsQ0FBRCxFQUFPLENBQUcsQ0FBekIsQ0ExQ3FDLENBMENYO0FBQzFCLFNBQUtDLE9BQUwsR0FBZSxZQUFNLENBQUcsQ0FBeEIsQ0EzQ3FDLENBMkNaO0FBQ3pCLFNBQUtDLE9BQUwsR0FBZSxZQUFNLENBQUcsQ0FBeEIsQ0E1Q3FDLENBNENaO0FBQ3pCLFNBQUtDLE1BQUwsR0FBYyxZQUFNLENBQUcsQ0FBdkIsQ0E3Q3FDLENBNkNiO0FBQ3hCLFNBQUtDLE9BQUwsR0FBZSxVQUFDQyxnQkFBRCxFQUFzQixDQUFHLENBQXhDLENBOUNxQyxDQThDSTtBQUN6QyxTQUFLQyxNQUFMLEdBQWMsVUFBQ0MsT0FBRCxFQUFhLENBQUcsQ0FBOUIsQ0EvQ3FDLENBK0NOO0FBQ2hDOztBQUVEOzs7Ozs7OzhCQUd1QztBQUFBOztBQUFBLFVBQTlCQyxnQkFBOEIsdUVBQVhDLDBCQUFXOztBQUNyQyxXQUFLaEMsTUFBTCxHQUFjK0IsaUJBQWlCRSxJQUFqQixDQUFzQixLQUFLekMsSUFBM0IsRUFBaUMsS0FBS0MsSUFBdEMsRUFBNEM7QUFDeER5QyxvQkFBWSxhQUQ0QztBQUV4RHJDLDRCQUFvQixLQUFLWSxXQUYrQjtBQUd4RDBCLFlBQUksS0FBS3pDLE9BQUwsQ0FBYXlDLEVBSHVDO0FBSXhEQyx1QkFBZSxLQUFLMUMsT0FBTCxDQUFhMEMsYUFKNEI7QUFLeERDLFlBQUksS0FBSzNDLE9BQUwsQ0FBYTJDO0FBTHVDLE9BQTVDLENBQWQ7O0FBUUE7QUFDQTtBQUNBLFVBQUk7QUFDRixhQUFLckMsTUFBTCxDQUFZc0MsTUFBWixHQUFxQixVQUFDQyxJQUFELEVBQVU7QUFBRSxnQkFBS0QsTUFBTCxJQUFlLE1BQUtBLE1BQUwsQ0FBWUMsSUFBWixDQUFmO0FBQWtDLFNBQW5FO0FBQ0QsT0FGRCxDQUVFLE9BQU9DLENBQVAsRUFBVSxDQUFHO0FBQ2YsV0FBS3hDLE1BQUwsQ0FBWXNCLE9BQVosR0FBc0IsS0FBS21CLFFBQUwsQ0FBY0MsSUFBZCxDQUFtQixJQUFuQixDQUF0QjtBQUNBLFdBQUsxQyxNQUFMLENBQVkyQyxNQUFaLEdBQXFCLEtBQUtDLE9BQUwsQ0FBYUYsSUFBYixDQUFrQixJQUFsQixDQUFyQjtBQUNEOztBQUVEOzs7Ozs7MkJBR1E7QUFDTixXQUFLckIsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLGlCQUE3QjtBQUNBLFdBQUswRCxZQUFMLENBQWtCLE1BQWxCO0FBQ0EsV0FBS3RDLGNBQUwsR0FBc0IsS0FBS3VDLEtBQTNCO0FBQ0Q7O0FBRUQ7Ozs7Ozs0QkFHUztBQUNQLFdBQUsxQixNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsdUJBQTdCO0FBQ0EsVUFBSSxLQUFLWSxNQUFMLElBQWUsS0FBS0EsTUFBTCxDQUFZZ0QsVUFBWixLQUEyQixNQUE5QyxFQUFzRDtBQUNwRCxhQUFLaEQsTUFBTCxDQUFZK0MsS0FBWjtBQUNELE9BRkQsTUFFTztBQUNMLGFBQUtFLFFBQUw7QUFDRDtBQUNGOztBQUVEOztBQUVBOzs7Ozs7Ozs7Z0NBTWFDLFEsRUFBVTtBQUNyQixXQUFLM0MsU0FBTCxHQUFpQjJDLFlBQVksRUFBN0I7QUFDQSxXQUFLM0MsU0FBTCxDQUFlNEMsSUFBZixHQUFzQixHQUFHQyxNQUFILENBQVUsS0FBSzdDLFNBQUwsQ0FBZTRDLElBQWYsSUFBd0IsZUFBZSxLQUFLekQsT0FBTCxDQUFhSyxJQUE5RCxFQUFxRSxDQUFyRSxDQUF0QjtBQUNBLFdBQUtRLFNBQUwsQ0FBZThDLEVBQWYsR0FBb0IsR0FBR0QsTUFBSCxDQUFVLEtBQUs3QyxTQUFMLENBQWU4QyxFQUFmLElBQXFCLEVBQS9CLENBQXBCOztBQUVBO0FBQ0EsV0FBSzlDLFNBQUwsQ0FBZStDLFNBQWYsR0FBMkIsR0FBR0YsTUFBSCxDQUFVLEtBQUs3QyxTQUFMLENBQWU4QyxFQUF6QixDQUEzQjtBQUNBLFdBQUs5QyxTQUFMLENBQWVnRCxVQUFmLEdBQTRCLEVBQTVCO0FBQ0EsV0FBS2hELFNBQUwsQ0FBZWlELGFBQWYsR0FBK0IsRUFBL0I7O0FBRUEsV0FBS2hELGNBQUwsR0FBc0IsS0FBS2lELFdBQTNCO0FBQ0EsV0FBS3BDLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2QixzQkFBN0I7QUFDQSxXQUFLMEQsWUFBTCxDQUFrQixnQkFBaUIsS0FBS3ZDLFNBQUwsQ0FBZTRDLElBQWhDLEdBQXdDLEdBQTFEO0FBQ0Q7O0FBRUQ7Ozs7Ozs7Ozs7eUJBT01PLEssRUFBTztBQUNYO0FBQ0EsVUFBSSxDQUFDLEtBQUtyRCxTQUFWLEVBQXFCO0FBQ25CO0FBQ0E7QUFDQSxlQUFPLElBQVA7QUFDRDs7QUFFRDtBQUNBLGFBQU8sS0FBS3NELFdBQUwsQ0FBaUJELEtBQWpCLENBQVA7QUFDRDs7QUFFRDs7Ozs7Ozs7Ozs7d0JBUUtBLEssRUFBTztBQUNWO0FBQ0EsVUFBSSxDQUFDLEtBQUtyRCxTQUFWLEVBQXFCO0FBQ25CO0FBQ0E7QUFDQSxlQUFPLElBQVA7QUFDRDs7QUFFRCxVQUFJcUQsU0FBU0EsTUFBTUUsTUFBbkIsRUFBMkI7QUFDekIsYUFBS0MsSUFBTCxDQUFVSCxLQUFWO0FBQ0Q7O0FBRUQ7QUFDQSxXQUFLbEQsY0FBTCxHQUFzQixLQUFLc0QsYUFBM0I7O0FBRUE7QUFDQTtBQUNBLFVBQUksS0FBS3hELGNBQUwsS0FBd0IsTUFBNUIsRUFBb0M7QUFDbEMsYUFBS0osU0FBTCxHQUFpQixLQUFLNkQsS0FBTCxDQUFXLElBQUlDLFVBQUosQ0FBZSxDQUFDLElBQUQsRUFBTyxJQUFQLEVBQWEsSUFBYixDQUFmLEVBQW1DQyxNQUE5QyxDQUFqQixDQURrQyxDQUNxQztBQUN4RSxPQUZELE1BRU8sSUFBSSxLQUFLM0QsY0FBTCxDQUFvQjRELE1BQXBCLENBQTJCLENBQUMsQ0FBNUIsTUFBbUMsSUFBdkMsRUFBNkM7QUFDbEQsYUFBS2hFLFNBQUwsR0FBaUIsS0FBSzZELEtBQUwsQ0FBVyxJQUFJQyxVQUFKLENBQWUsQ0FBQyxJQUFELEVBQU8sSUFBUCxFQUFhLElBQWIsRUFBbUIsSUFBbkIsQ0FBZixFQUF5Q0MsTUFBcEQsQ0FBakIsQ0FEa0QsQ0FDMkI7QUFDOUUsT0FGTSxNQUVBO0FBQ0wsYUFBSy9ELFNBQUwsR0FBaUIsS0FBSzZELEtBQUwsQ0FBVyxJQUFJQyxVQUFKLENBQWUsQ0FBQyxJQUFELEVBQU8sSUFBUCxFQUFhLElBQWIsRUFBbUIsSUFBbkIsRUFBeUIsSUFBekIsQ0FBZixFQUErQ0MsTUFBMUQsQ0FBakIsQ0FESyxDQUM4RTtBQUNwRjs7QUFFRDtBQUNBLFdBQUs1RCxTQUFMLEdBQWlCLEtBQWpCO0FBQ0EsV0FBS00sbUJBQUwsR0FBMkIsS0FBM0I7QUFDQSxXQUFLQyxvQkFBTCxHQUE0QixLQUE1Qjs7QUFFQSxhQUFPLEtBQUtWLFNBQVo7QUFDRDs7QUFFRDs7QUFFQTs7Ozs7Ozs7MkJBS1F3RCxLLEVBQU87QUFDYjtBQUNBLFVBQUlTLFFBQVEsQ0FBQyxLQUFLbkQsZUFBTCxJQUF3QjBDLFNBQVMsRUFBakMsQ0FBRCxFQUF1Q1UsS0FBdkMsQ0FBNkMsT0FBN0MsQ0FBWjtBQUNBLFdBQUtwRCxlQUFMLEdBQXVCbUQsTUFBTUUsR0FBTixFQUF2QixDQUhhLENBR3NCOztBQUVuQyxXQUFLLElBQUlDLElBQUksQ0FBUixFQUFXQyxNQUFNSixNQUFNUCxNQUE1QixFQUFvQ1UsSUFBSUMsR0FBeEMsRUFBNkNELEdBQTdDLEVBQWtEO0FBQ2hELFlBQUksQ0FBQ0gsTUFBTUcsQ0FBTixFQUFTRSxJQUFULEVBQUwsRUFBc0I7QUFDcEI7QUFDQTtBQUNEOztBQUVEO0FBQ0E7QUFDQTtBQUNBOztBQUVBLFlBQU1DLFFBQVFOLE1BQU1HLENBQU4sRUFBU0csS0FBVCxDQUFlLDZDQUFmLENBQWQ7O0FBRUEsWUFBSUEsS0FBSixFQUFXO0FBQ1QsZUFBSzVELFdBQUwsQ0FBaUJDLElBQWpCLENBQXNCNEQsSUFBdEIsQ0FBMkJELE1BQU0sQ0FBTixDQUEzQjs7QUFFQSxjQUFJQSxNQUFNLENBQU4sTUFBYSxHQUFqQixFQUFzQjtBQUNwQjtBQUNBLGlCQUFLNUQsV0FBTCxDQUFpQkUsVUFBakIsR0FBOEIsS0FBS0YsV0FBTCxDQUFpQkUsVUFBakIsSUFBK0I0RCxPQUFPRixNQUFNLENBQU4sQ0FBUCxDQUE3RDtBQUNELFdBSEQsTUFHTztBQUNMLGdCQUFNMUQsYUFBYTRELE9BQU9GLE1BQU0sQ0FBTixDQUFQLEtBQW9CLENBQXZDO0FBQ0EsZ0JBQU1HLFdBQVc7QUFDZjdELG9DQURlO0FBRWZELG9CQUFNLEtBQUtELFdBQUwsQ0FBaUJDLElBQWpCLENBQXNCK0QsSUFBdEIsQ0FBMkIsSUFBM0IsQ0FGUztBQUdmL0MsdUJBQVNmLGNBQWMsR0FBZCxJQUFxQkEsYUFBYTtBQUg1QixhQUFqQjs7QUFNQSxpQkFBSytELFVBQUwsQ0FBZ0JGLFFBQWhCO0FBQ0EsaUJBQUsvRCxXQUFMLEdBQW1CO0FBQ2pCQyxvQkFBTSxFQURXO0FBRWpCQywwQkFBWTtBQUZLLGFBQW5CO0FBSUQ7QUFDRixTQXBCRCxNQW9CTztBQUNMLGVBQUsrRCxVQUFMLENBQWdCO0FBQ2RoRCxxQkFBUyxLQURLO0FBRWRmLHdCQUFZLEtBQUtGLFdBQUwsQ0FBaUJFLFVBQWpCLElBQStCLElBRjdCO0FBR2RELGtCQUFNLENBQUNxRCxNQUFNRyxDQUFOLENBQUQsRUFBV08sSUFBWCxDQUFnQixJQUFoQjtBQUhRLFdBQWhCO0FBS0EsZUFBS2hFLFdBQUwsR0FBbUI7QUFDakJDLGtCQUFNLEVBRFc7QUFFakJDLHdCQUFZO0FBRkssV0FBbkI7QUFJRDtBQUNGO0FBQ0Y7O0FBRUQ7O0FBRUE7Ozs7Ozs7Ozs7NEJBT1NnRSxLLEVBQU87QUFDZCxVQUFJQSxTQUFTQSxNQUFNakUsSUFBZixJQUF1QmlFLE1BQU1qRSxJQUFOLENBQVdrRSxhQUF0QyxFQUFxRDtBQUNuRCxhQUFLdEYsT0FBTCxDQUFhSyxJQUFiLEdBQW9CZ0YsTUFBTWpFLElBQU4sQ0FBV2tFLGFBQS9CO0FBQ0Q7O0FBRUQsV0FBS2hGLE1BQUwsQ0FBWWlGLE1BQVosR0FBcUIsS0FBS0MsT0FBTCxDQUFheEMsSUFBYixDQUFrQixJQUFsQixDQUFyQjs7QUFFQSxXQUFLMUMsTUFBTCxDQUFZeUIsT0FBWixHQUFzQixLQUFLMEQsUUFBTCxDQUFjekMsSUFBZCxDQUFtQixJQUFuQixDQUF0QjtBQUNBLFdBQUsxQyxNQUFMLENBQVl3QixPQUFaLEdBQXNCLEtBQUs0RCxRQUFMLENBQWMxQyxJQUFkLENBQW1CLElBQW5CLENBQXRCOztBQUVBLFdBQUtsQyxjQUFMLEdBQXNCLEtBQUs2RSxlQUEzQjtBQUNEOztBQUVEOzs7Ozs7Ozs7NEJBTVNDLEcsRUFBSztBQUNaQyxtQkFBYSxLQUFLN0UsbUJBQWxCO0FBQ0EsVUFBSThFLGdCQUFnQixJQUFJQyx5QkFBSixDQUFnQixPQUFoQixFQUF5QkMsTUFBekIsQ0FBZ0MsSUFBSTFCLFVBQUosQ0FBZXNCLElBQUl4RSxJQUFuQixDQUFoQyxDQUFwQjtBQUNBLFdBQUtPLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2QixhQUFhb0csYUFBMUM7QUFDQSxXQUFLRyxNQUFMLENBQVlILGFBQVo7QUFDRDs7QUFFRDs7Ozs7Ozs7OytCQU1ZO0FBQ1YsV0FBS3RGLFNBQUwsR0FBaUIsS0FBakI7QUFDQSxXQUFLc0IsT0FBTDtBQUNEOztBQUVEOzs7Ozs7Ozs7NkJBTVU4RCxHLEVBQUs7QUFDYixVQUFJQSxlQUFlTSxLQUFmLElBQXdCTixJQUFJTyxPQUFoQyxFQUF5QztBQUN2QyxhQUFLeEUsTUFBTCxDQUFZeUUsS0FBWixDQUFrQjFHLFNBQWxCLEVBQTZCa0csR0FBN0I7QUFDQSxhQUFLaEUsT0FBTCxDQUFhZ0UsR0FBYjtBQUNELE9BSEQsTUFHTyxJQUFJQSxPQUFPQSxJQUFJeEUsSUFBSixZQUFvQjhFLEtBQS9CLEVBQXNDO0FBQzNDLGFBQUt2RSxNQUFMLENBQVl5RSxLQUFaLENBQWtCMUcsU0FBbEIsRUFBNkJrRyxJQUFJeEUsSUFBakM7QUFDQSxhQUFLUSxPQUFMLENBQWFnRSxJQUFJeEUsSUFBakI7QUFDRCxPQUhNLE1BR0E7QUFDTCxhQUFLTyxNQUFMLENBQVl5RSxLQUFaLENBQWtCMUcsU0FBbEIsRUFBNkIsSUFBSXdHLEtBQUosQ0FBV04sT0FBT0EsSUFBSXhFLElBQVgsSUFBbUJ3RSxJQUFJeEUsSUFBSixDQUFTK0UsT0FBN0IsSUFBeUNQLElBQUl4RSxJQUE3QyxJQUFxRHdFLEdBQXJELElBQTRELE9BQXRFLENBQTdCO0FBQ0EsYUFBS2hFLE9BQUwsQ0FBYSxJQUFJc0UsS0FBSixDQUFXTixPQUFPQSxJQUFJeEUsSUFBWCxJQUFtQndFLElBQUl4RSxJQUFKLENBQVMrRSxPQUE3QixJQUF5Q1AsSUFBSXhFLElBQTdDLElBQXFEd0UsR0FBckQsSUFBNEQsT0FBdEUsQ0FBYjtBQUNEOztBQUVELFdBQUt2QyxLQUFMO0FBQ0Q7O0FBRUQ7Ozs7Ozs7OzsrQkFNWTtBQUNWLFdBQUsxQixNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsZ0JBQTdCO0FBQ0EsV0FBSzZELFFBQUw7QUFDRDs7QUFFRDs7Ozs7Ozs7OzsrQkFPWThDLE8sRUFBUztBQUNuQixVQUFJLE9BQU8sS0FBS3ZGLGNBQVosS0FBK0IsVUFBbkMsRUFBK0M7QUFDN0MsYUFBS0EsY0FBTCxDQUFvQnVGLE9BQXBCO0FBQ0Q7QUFDRjs7O2lDQUVhO0FBQ1o7QUFDQSxVQUFJRCxRQUFRLElBQUlGLEtBQUosQ0FBVSxtQkFBVixDQUFaO0FBQ0EsV0FBS25ELFFBQUwsQ0FBY3FELEtBQWQ7QUFDRDs7QUFFRDs7Ozs7OytCQUdZO0FBQ1ZQLG1CQUFhLEtBQUs3RSxtQkFBbEI7O0FBRUEsVUFBSSxDQUFDLEtBQUtULFNBQVYsRUFBcUI7QUFDbkIsYUFBS0EsU0FBTCxHQUFpQixJQUFqQjtBQUNBLGFBQUt3QixPQUFMO0FBQ0Q7QUFDRjs7QUFFRDs7Ozs7Ozs7O2dDQU1haUMsSyxFQUFPO0FBQ2xCO0FBQ0EsVUFBSSxDQUFDLEtBQUtoRSxPQUFMLENBQWFzRyxlQUFsQixFQUFtQztBQUNqQ3RDLGdCQUFRQSxNQUFNdUMsT0FBTixDQUFjLE9BQWQsRUFBdUIsTUFBdkIsQ0FBUjtBQUNBLFlBQUksQ0FBQyxLQUFLM0YsY0FBTCxDQUFvQjRELE1BQXBCLENBQTJCLENBQUMsQ0FBNUIsTUFBbUMsSUFBbkMsSUFBMkMsQ0FBQyxLQUFLNUQsY0FBbEQsS0FBcUVvRCxNQUFNd0MsTUFBTixDQUFhLENBQWIsTUFBb0IsR0FBN0YsRUFBa0c7QUFDaEd4QyxrQkFBUSxNQUFNQSxLQUFkO0FBQ0Q7QUFDRjs7QUFFRDtBQUNBO0FBQ0EsVUFBSUEsTUFBTUUsTUFBTixHQUFlLENBQW5CLEVBQXNCO0FBQ3BCLGFBQUt0RCxjQUFMLEdBQXNCb0QsTUFBTVEsTUFBTixDQUFhLENBQUMsQ0FBZCxDQUF0QjtBQUNELE9BRkQsTUFFTyxJQUFJUixNQUFNRSxNQUFOLEtBQWlCLENBQXJCLEVBQXdCO0FBQzdCLGFBQUt0RCxjQUFMLEdBQXNCLEtBQUtBLGNBQUwsQ0FBb0I0RCxNQUFwQixDQUEyQixDQUFDLENBQTVCLElBQWlDUixLQUF2RDtBQUNEOztBQUVELFdBQUtyQyxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsYUFBYXNFLE1BQU1FLE1BQW5CLEdBQTRCLG1CQUF6RDs7QUFFQTtBQUNBLFdBQUsxRCxTQUFMLEdBQWlCLEtBQUs2RCxLQUFMLENBQVcsSUFBSW9DLHlCQUFKLENBQWdCLE9BQWhCLEVBQXlCQyxNQUF6QixDQUFnQzFDLEtBQWhDLEVBQXVDTyxNQUFsRCxDQUFqQjtBQUNBLGFBQU8sS0FBSy9ELFNBQVo7QUFDRDs7QUFFRDs7Ozs7Ozs7aUNBS2NtRyxHLEVBQUs7QUFDakIsV0FBS25HLFNBQUwsR0FBaUIsS0FBSzZELEtBQUwsQ0FBVyxJQUFJb0MseUJBQUosQ0FBZ0IsT0FBaEIsRUFBeUJDLE1BQXpCLENBQWdDQyxPQUFPQSxJQUFJbkMsTUFBSixDQUFXLENBQUMsQ0FBWixNQUFtQixNQUFuQixHQUE0QixNQUE1QixHQUFxQyxFQUE1QyxDQUFoQyxFQUFpRkQsTUFBNUYsQ0FBakI7QUFDRDs7OzBCQUVNQSxNLEVBQVE7QUFDYixXQUFLcUMsV0FBTCxDQUFpQnJDLE9BQU9zQyxVQUF4QjtBQUNBLGFBQU8sS0FBS3ZHLE1BQUwsQ0FBWTZELElBQVosQ0FBaUJJLE1BQWpCLENBQVA7QUFDRDs7O2dDQUVZc0MsVSxFQUFZO0FBQ3ZCLFVBQUlDLGdCQUFnQkMsS0FBS0MsS0FBTCxDQUFXSCxhQUFhLEtBQUszRyx1QkFBN0IsQ0FBcEI7QUFDQSxVQUFJK0csT0FBSjs7QUFFQSxVQUFJLEtBQUt0RyxTQUFULEVBQW9CO0FBQ2xCO0FBQ0EsWUFBSXVHLE1BQU1DLEtBQUtELEdBQUwsRUFBVjs7QUFFQTtBQUNBLGFBQUtqRyxtQkFBTCxHQUEyQixLQUFLQSxtQkFBTCxJQUE0QmlHLEdBQXZEOztBQUVBO0FBQ0EsYUFBS2hHLG9CQUFMLEdBQTRCLENBQUMsS0FBS0Esb0JBQUwsSUFBNkIsS0FBS2pCLHVCQUFuQyxJQUE4RDZHLGFBQTFGOztBQUVBO0FBQ0FHLGtCQUFVLEtBQUtoRyxtQkFBTCxHQUEyQixLQUFLQyxvQkFBaEMsR0FBdURnRyxHQUFqRTtBQUNELE9BWkQsTUFZTztBQUNMO0FBQ0FELGtCQUFVLEtBQUtoSCx1QkFBTCxHQUErQjZHLGFBQXpDO0FBQ0Q7O0FBRURqQixtQkFBYSxLQUFLN0UsbUJBQWxCLEVBckJ1QixDQXFCZ0I7QUFDdkMsV0FBS0EsbUJBQUwsR0FBMkJvRyxXQUFXLEtBQUtDLFVBQUwsQ0FBZ0JyRSxJQUFoQixDQUFxQixJQUFyQixDQUFYLEVBQXVDaUUsT0FBdkMsQ0FBM0IsQ0F0QnVCLENBc0JvRDtBQUM1RTs7QUFFRDs7Ozs7O3dDQUdxQjtBQUNuQixVQUFJLENBQUMsS0FBS2pILE9BQUwsQ0FBYUksSUFBbEIsRUFBd0I7QUFDdEI7QUFDQSxhQUFLVSxjQUFMLEdBQXNCLEtBQUt3RyxXQUEzQjtBQUNBLGFBQUt0RixNQUFMLEdBSHNCLENBR1I7QUFDZDtBQUNEOztBQUVELFVBQUk1QixJQUFKOztBQUVBLFVBQUksQ0FBQyxLQUFLSixPQUFMLENBQWF1SCxVQUFkLElBQTRCLEtBQUt2SCxPQUFMLENBQWFJLElBQWIsQ0FBa0JvSCxPQUFsRCxFQUEyRDtBQUN6RCxhQUFLeEgsT0FBTCxDQUFhdUgsVUFBYixHQUEwQixTQUExQjtBQUNEOztBQUVELFVBQUksS0FBS3ZILE9BQUwsQ0FBYXVILFVBQWpCLEVBQTZCO0FBQzNCbkgsZUFBTyxLQUFLSixPQUFMLENBQWF1SCxVQUFiLENBQXdCRSxXQUF4QixHQUFzQzNDLElBQXRDLEVBQVA7QUFDRCxPQUZELE1BRU87QUFDTDtBQUNBMUUsZUFBTyxDQUFDLEtBQUtNLGNBQUwsQ0FBb0IsQ0FBcEIsS0FBMEIsT0FBM0IsRUFBb0MrRyxXQUFwQyxHQUFrRDNDLElBQWxELEVBQVA7QUFDRDs7QUFFRCxjQUFRMUUsSUFBUjtBQUNFLGFBQUssT0FBTDtBQUNFO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsZUFBS3VCLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2QiwrQkFBN0I7QUFDQSxlQUFLb0IsY0FBTCxHQUFzQixLQUFLNEcsc0JBQTNCO0FBQ0EsZUFBS3RFLFlBQUwsQ0FBa0IsWUFBbEI7QUFDQTtBQUNGLGFBQUssT0FBTDtBQUNFO0FBQ0E7QUFDQSxlQUFLekIsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLCtCQUE3QjtBQUNBLGVBQUtvQixjQUFMLEdBQXNCLEtBQUs2RyxtQkFBM0I7QUFDQSxlQUFLdkUsWUFBTDtBQUNFO0FBQ0EsMEJBQ0E7QUFDRTtBQUNBLGlCQUFXO0FBQ1gsZUFBS3BELE9BQUwsQ0FBYUksSUFBYixDQUFrQndILElBRGxCLEdBQ3lCLElBRHpCLEdBRUEsS0FBSzVILE9BQUwsQ0FBYUksSUFBYixDQUFrQnlILElBSnBCLENBSEY7QUFTQTtBQUNGLGFBQUssU0FBTDtBQUNFO0FBQ0EsZUFBS2xHLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2QixpQ0FBN0I7QUFDQSxlQUFLb0IsY0FBTCxHQUFzQixLQUFLZ0gsbUJBQTNCO0FBQ0EsZUFBSzFFLFlBQUwsQ0FBa0Isa0JBQWtCLEtBQUsyRSxrQkFBTCxDQUF3QixLQUFLL0gsT0FBTCxDQUFhSSxJQUFiLENBQWtCd0gsSUFBMUMsRUFBZ0QsS0FBSzVILE9BQUwsQ0FBYUksSUFBYixDQUFrQm9ILE9BQWxFLENBQXBDO0FBQ0E7QUE5Qko7O0FBaUNBLFdBQUt6RSxRQUFMLENBQWMsSUFBSW1ELEtBQUosQ0FBVSxtQ0FBbUM5RixJQUE3QyxDQUFkO0FBQ0Q7O0FBRUQ7O0FBRUE7Ozs7Ozs7O29DQUtpQmlHLE8sRUFBUztBQUN4QixVQUFJQSxRQUFRaEYsVUFBUixLQUF1QixHQUEzQixFQUFnQztBQUM5QixhQUFLMEIsUUFBTCxDQUFjLElBQUltRCxLQUFKLENBQVUsdUJBQXVCRyxRQUFRakYsSUFBekMsQ0FBZDtBQUNBO0FBQ0Q7O0FBRUQsVUFBSSxLQUFLcEIsT0FBTCxDQUFhZ0ksSUFBakIsRUFBdUI7QUFDckIsYUFBS3JHLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2QixrQkFBa0IsS0FBS00sT0FBTCxDQUFhSyxJQUE1RDs7QUFFQSxhQUFLUyxjQUFMLEdBQXNCLEtBQUttSCxXQUEzQjtBQUNBLGFBQUs3RSxZQUFMLENBQWtCLFVBQVUsS0FBS3BELE9BQUwsQ0FBYUssSUFBekM7QUFDRCxPQUxELE1BS087QUFDTCxhQUFLc0IsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLGtCQUFrQixLQUFLTSxPQUFMLENBQWFLLElBQTVEOztBQUVBLGFBQUtTLGNBQUwsR0FBc0IsS0FBS29ILFdBQTNCO0FBQ0EsYUFBSzlFLFlBQUwsQ0FBa0IsVUFBVSxLQUFLcEQsT0FBTCxDQUFhSyxJQUF6QztBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7O2dDQUthZ0csTyxFQUFTO0FBQ3BCLFVBQUksQ0FBQ0EsUUFBUWpFLE9BQWIsRUFBc0I7QUFDcEIsYUFBS1QsTUFBTCxDQUFZeUUsS0FBWixDQUFrQjFHLFNBQWxCLEVBQTZCLHFCQUE3QjtBQUNBLGFBQUtxRCxRQUFMLENBQWMsSUFBSW1ELEtBQUosQ0FBVUcsUUFBUWpGLElBQWxCLENBQWQ7QUFDQTtBQUNEOztBQUVEO0FBQ0EsV0FBSzhHLFdBQUwsQ0FBaUI3QixPQUFqQjtBQUNEOztBQUVEOzs7Ozs7OztnQ0FLYUEsTyxFQUFTO0FBQ3BCLFVBQUl0QixLQUFKOztBQUVBLFVBQUksQ0FBQ3NCLFFBQVFqRSxPQUFiLEVBQXNCO0FBQ3BCLFlBQUksQ0FBQyxLQUFLckIsV0FBTixJQUFxQixLQUFLZixPQUFMLENBQWFtSSxVQUF0QyxFQUFrRDtBQUNoRCxjQUFJQyxTQUFTLHFDQUFiO0FBQ0EsZUFBS3pHLE1BQUwsQ0FBWXlFLEtBQVosQ0FBa0IxRyxTQUFsQixFQUE2QjBJLE1BQTdCO0FBQ0EsZUFBS3JGLFFBQUwsQ0FBYyxJQUFJbUQsS0FBSixDQUFVa0MsTUFBVixDQUFkO0FBQ0E7QUFDRDs7QUFFRDtBQUNBLGFBQUt6RyxNQUFMLENBQVkwRyxPQUFaLENBQW9CM0ksU0FBcEIsRUFBK0Isc0NBQXNDLEtBQUtNLE9BQUwsQ0FBYUssSUFBbEY7QUFDQSxhQUFLUyxjQUFMLEdBQXNCLEtBQUt3SCxXQUEzQjtBQUNBLGFBQUtsRixZQUFMLENBQWtCLFVBQVUsS0FBS3BELE9BQUwsQ0FBYUssSUFBekM7QUFDQTtBQUNEOztBQUVEO0FBQ0EsVUFBSWdHLFFBQVFqRixJQUFSLENBQWEyRCxLQUFiLENBQW1CLGdDQUFuQixDQUFKLEVBQTBEO0FBQ3hELGFBQUtwRCxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsNEJBQTdCO0FBQ0EsYUFBS2dCLGNBQUwsQ0FBb0JzRSxJQUFwQixDQUF5QixPQUF6QjtBQUNEOztBQUVEO0FBQ0EsVUFBSXFCLFFBQVFqRixJQUFSLENBQWEyRCxLQUFiLENBQW1CLGdDQUFuQixDQUFKLEVBQTBEO0FBQ3hELGFBQUtwRCxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsNEJBQTdCO0FBQ0EsYUFBS2dCLGNBQUwsQ0FBb0JzRSxJQUFwQixDQUF5QixPQUF6QjtBQUNEOztBQUVEO0FBQ0EsVUFBSXFCLFFBQVFqRixJQUFSLENBQWEyRCxLQUFiLENBQW1CLGtDQUFuQixDQUFKLEVBQTREO0FBQzFELGFBQUtwRCxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsOEJBQTdCO0FBQ0EsYUFBS2dCLGNBQUwsQ0FBb0JzRSxJQUFwQixDQUF5QixTQUF6QjtBQUNEOztBQUVEO0FBQ0EsVUFBSSxDQUFDRCxRQUFRc0IsUUFBUWpGLElBQVIsQ0FBYTJELEtBQWIsQ0FBbUIsYUFBbkIsQ0FBVCxLQUErQ0UsT0FBT0YsTUFBTSxDQUFOLENBQVAsQ0FBbkQsRUFBcUU7QUFDbkUsWUFBTXdELGlCQUFpQnRELE9BQU9GLE1BQU0sQ0FBTixDQUFQLENBQXZCO0FBQ0EsYUFBS3BELE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2QixrQ0FBa0M2SSxjQUEvRDtBQUNEOztBQUVEO0FBQ0EsVUFBSSxDQUFDLEtBQUt4SCxXQUFWLEVBQXVCO0FBQ3JCLFlBQUtzRixRQUFRakYsSUFBUixDQUFhMkQsS0FBYixDQUFtQixnQkFBbkIsS0FBd0MsQ0FBQyxLQUFLL0UsT0FBTCxDQUFhd0ksU0FBdkQsSUFBcUUsQ0FBQyxDQUFDLEtBQUt4SSxPQUFMLENBQWFtSSxVQUF4RixFQUFvRztBQUNsRyxlQUFLckgsY0FBTCxHQUFzQixLQUFLMkgsZUFBM0I7QUFDQSxlQUFLOUcsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLGtCQUE3QjtBQUNBLGVBQUswRCxZQUFMLENBQWtCLFVBQWxCO0FBQ0E7QUFDRDtBQUNGOztBQUVELFdBQUtzRixpQkFBTDtBQUNEOztBQUVEOzs7Ozs7Ozs7O29DQU9pQnJDLE8sRUFBUztBQUN4QixVQUFJLENBQUNBLFFBQVFqRSxPQUFiLEVBQXNCO0FBQ3BCLGFBQUtULE1BQUwsQ0FBWXlFLEtBQVosQ0FBa0IxRyxTQUFsQixFQUE2Qix5QkFBN0I7QUFDQSxhQUFLcUQsUUFBTCxDQUFjLElBQUltRCxLQUFKLENBQVVHLFFBQVFqRixJQUFsQixDQUFkO0FBQ0E7QUFDRDs7QUFFRCxXQUFLTCxXQUFMLEdBQW1CLElBQW5CO0FBQ0EsV0FBS1QsTUFBTCxDQUFZcUksZUFBWjs7QUFFQTtBQUNBLFdBQUs3SCxjQUFMLEdBQXNCLEtBQUtvSCxXQUEzQjtBQUNBLFdBQUs5RSxZQUFMLENBQWtCLFVBQVUsS0FBS3BELE9BQUwsQ0FBYUssSUFBekM7QUFDRDs7QUFFRDs7Ozs7Ozs7Z0NBS2FnRyxPLEVBQVM7QUFDcEIsVUFBSSxDQUFDQSxRQUFRakUsT0FBYixFQUFzQjtBQUNwQixhQUFLVCxNQUFMLENBQVl5RSxLQUFaLENBQWtCMUcsU0FBbEIsRUFBNkIscUJBQTdCO0FBQ0EsYUFBS3FELFFBQUwsQ0FBYyxJQUFJbUQsS0FBSixDQUFVRyxRQUFRakYsSUFBbEIsQ0FBZDtBQUNBO0FBQ0Q7QUFDRCxXQUFLc0gsaUJBQUw7QUFDRDs7QUFFRDs7Ozs7Ozs7MkNBS3dCckMsTyxFQUFTO0FBQy9CLFVBQUlBLFFBQVFoRixVQUFSLEtBQXVCLEdBQXZCLElBQThCZ0YsUUFBUWpGLElBQVIsS0FBaUIsY0FBbkQsRUFBbUU7QUFDakUsYUFBS08sTUFBTCxDQUFZeUUsS0FBWixDQUFrQjFHLFNBQWxCLEVBQTZCLHFDQUFxQzJHLFFBQVFqRixJQUExRTtBQUNBLGFBQUsyQixRQUFMLENBQWMsSUFBSW1ELEtBQUosQ0FBVSxtRUFBbUVHLFFBQVFqRixJQUFyRixDQUFkO0FBQ0E7QUFDRDtBQUNELFdBQUtPLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2Qiw0QkFBN0I7QUFDQSxXQUFLb0IsY0FBTCxHQUFzQixLQUFLOEgsc0JBQTNCO0FBQ0EsV0FBS3hGLFlBQUwsQ0FBa0IseUJBQU8sS0FBS3BELE9BQUwsQ0FBYUksSUFBYixDQUFrQndILElBQXpCLENBQWxCO0FBQ0Q7O0FBRUQ7Ozs7Ozs7OzJDQUt3QnZCLE8sRUFBUztBQUMvQixVQUFJQSxRQUFRaEYsVUFBUixLQUF1QixHQUF2QixJQUE4QmdGLFFBQVFqRixJQUFSLEtBQWlCLGNBQW5ELEVBQW1FO0FBQ2pFLGFBQUtPLE1BQUwsQ0FBWXlFLEtBQVosQ0FBa0IxRyxTQUFsQixFQUE2QixxQ0FBcUMyRyxRQUFRakYsSUFBMUU7QUFDQSxhQUFLMkIsUUFBTCxDQUFjLElBQUltRCxLQUFKLENBQVUsbUVBQW1FRyxRQUFRakYsSUFBckYsQ0FBZDtBQUNBO0FBQ0Q7QUFDRCxXQUFLTyxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsNEJBQTdCO0FBQ0EsV0FBS29CLGNBQUwsR0FBc0IsS0FBSzZHLG1CQUEzQjtBQUNBLFdBQUt2RSxZQUFMLENBQWtCLHlCQUFPLEtBQUtwRCxPQUFMLENBQWFJLElBQWIsQ0FBa0J5SCxJQUF6QixDQUFsQjtBQUNEOztBQUVEOzs7Ozs7Ozt3Q0FLcUJ4QixPLEVBQVM7QUFDNUIsVUFBSSxDQUFDQSxRQUFRakUsT0FBYixFQUFzQjtBQUNwQixhQUFLVCxNQUFMLENBQVkwRyxPQUFaLENBQW9CM0ksU0FBcEIsRUFBK0IsbURBQS9CO0FBQ0EsYUFBSzBELFlBQUwsQ0FBa0IsRUFBbEI7QUFDQSxhQUFLdEMsY0FBTCxHQUFzQixLQUFLNkcsbUJBQTNCO0FBQ0QsT0FKRCxNQUlPO0FBQ0wsYUFBS0EsbUJBQUwsQ0FBeUJ0QixPQUF6QjtBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7Ozt3Q0FNcUJBLE8sRUFBUztBQUM1QixVQUFJLENBQUNBLFFBQVFqRSxPQUFiLEVBQXNCO0FBQ3BCLGFBQUtULE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2Qiw0QkFBNEIyRyxRQUFRakYsSUFBakU7QUFDQSxhQUFLMkIsUUFBTCxDQUFjLElBQUltRCxLQUFKLENBQVVHLFFBQVFqRixJQUFsQixDQUFkO0FBQ0E7QUFDRDs7QUFFRCxXQUFLTyxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsNEJBQTdCOztBQUVBLFdBQUtlLGdCQUFMLEdBQXdCLEtBQUtULE9BQUwsQ0FBYUksSUFBYixDQUFrQndILElBQTFDOztBQUVBLFdBQUs5RyxjQUFMLEdBQXNCLEtBQUt3RyxXQUEzQjtBQUNBLFdBQUt0RixNQUFMLEdBWjRCLENBWWQ7QUFDZjs7QUFFRDs7Ozs7Ozs7Z0NBS2FxRSxPLEVBQVM7QUFDcEIsVUFBSUEsUUFBUWhGLFVBQVIsR0FBcUIsR0FBekIsRUFBOEI7QUFDNUIsYUFBSzBCLFFBQUwsQ0FBYyxJQUFJbUQsS0FBSixDQUFVRyxRQUFRakYsSUFBbEIsQ0FBZDtBQUNBO0FBQ0Q7O0FBRUQsV0FBSzJCLFFBQUwsQ0FBYyxJQUFJbUQsS0FBSixDQUFVRyxRQUFRakYsSUFBbEIsQ0FBZDtBQUNEOztBQUVEOzs7Ozs7OztnQ0FLYWlGLE8sRUFBUztBQUNwQixVQUFJLENBQUNBLFFBQVFqRSxPQUFiLEVBQXNCO0FBQ3BCLGFBQUtULE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2Qiw2QkFBNkIyRyxRQUFRakYsSUFBbEU7QUFDQSxhQUFLMkIsUUFBTCxDQUFjLElBQUltRCxLQUFKLENBQVVHLFFBQVFqRixJQUFsQixDQUFkO0FBQ0E7QUFDRDs7QUFFRCxVQUFJLENBQUMsS0FBS1AsU0FBTCxDQUFlK0MsU0FBZixDQUF5Qk0sTUFBOUIsRUFBc0M7QUFDcEMsYUFBS25CLFFBQUwsQ0FBYyxJQUFJbUQsS0FBSixDQUFVLDBDQUFWLENBQWQ7QUFDRCxPQUZELE1BRU87QUFDTCxhQUFLdkUsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLDJDQUEyQyxLQUFLbUIsU0FBTCxDQUFlK0MsU0FBZixDQUF5Qk0sTUFBcEUsR0FBNkUsYUFBMUc7QUFDQSxhQUFLdkMsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLHFCQUE3QjtBQUNBLGFBQUttQixTQUFMLENBQWVnSSxZQUFmLEdBQThCLEtBQUtoSSxTQUFMLENBQWUrQyxTQUFmLENBQXlCa0YsS0FBekIsRUFBOUI7QUFDQSxhQUFLaEksY0FBTCxHQUFzQixLQUFLaUksV0FBM0I7QUFDQSxhQUFLM0YsWUFBTCxDQUFrQixjQUFjLEtBQUt2QyxTQUFMLENBQWVnSSxZQUE3QixHQUE0QyxHQUE5RDtBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7Ozs7Z0NBT2F4QyxPLEVBQVM7QUFDcEIsVUFBSSxDQUFDQSxRQUFRakUsT0FBYixFQUFzQjtBQUNwQixhQUFLVCxNQUFMLENBQVkwRyxPQUFaLENBQW9CM0ksU0FBcEIsRUFBK0IseUJBQXlCLEtBQUttQixTQUFMLENBQWVnSSxZQUF2RTtBQUNBO0FBQ0EsYUFBS2hJLFNBQUwsQ0FBZWdELFVBQWYsQ0FBMEJtQixJQUExQixDQUErQixLQUFLbkUsU0FBTCxDQUFlZ0ksWUFBOUM7QUFDRCxPQUpELE1BSU87QUFDTCxhQUFLaEksU0FBTCxDQUFlaUQsYUFBZixDQUE2QmtCLElBQTdCLENBQWtDLEtBQUtuRSxTQUFMLENBQWVnSSxZQUFqRDtBQUNEOztBQUVELFVBQUksQ0FBQyxLQUFLaEksU0FBTCxDQUFlK0MsU0FBZixDQUF5Qk0sTUFBOUIsRUFBc0M7QUFDcEMsWUFBSSxLQUFLckQsU0FBTCxDQUFlZ0QsVUFBZixDQUEwQkssTUFBMUIsR0FBbUMsS0FBS3JELFNBQUwsQ0FBZThDLEVBQWYsQ0FBa0JPLE1BQXpELEVBQWlFO0FBQy9ELGVBQUtwRCxjQUFMLEdBQXNCLEtBQUtrSSxXQUEzQjtBQUNBLGVBQUtySCxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsdUNBQTdCO0FBQ0EsZUFBSzBELFlBQUwsQ0FBa0IsTUFBbEI7QUFDRCxTQUpELE1BSU87QUFDTCxlQUFLTCxRQUFMLENBQWMsSUFBSW1ELEtBQUosQ0FBVSxpREFBVixDQUFkO0FBQ0EsZUFBS3BGLGNBQUwsR0FBc0IsS0FBS3dHLFdBQTNCO0FBQ0Q7QUFDRixPQVRELE1BU087QUFDTCxhQUFLM0YsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLHFCQUE3QjtBQUNBLGFBQUttQixTQUFMLENBQWVnSSxZQUFmLEdBQThCLEtBQUtoSSxTQUFMLENBQWUrQyxTQUFmLENBQXlCa0YsS0FBekIsRUFBOUI7QUFDQSxhQUFLaEksY0FBTCxHQUFzQixLQUFLaUksV0FBM0I7QUFDQSxhQUFLM0YsWUFBTCxDQUFrQixjQUFjLEtBQUt2QyxTQUFMLENBQWVnSSxZQUE3QixHQUE0QyxHQUE5RDtBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7O2dDQUtheEMsTyxFQUFTO0FBQ3BCO0FBQ0E7QUFDQSxVQUFJLENBQUMsR0FBRCxFQUFNLEdBQU4sRUFBVzRDLE9BQVgsQ0FBbUI1QyxRQUFRaEYsVUFBM0IsSUFBeUMsQ0FBN0MsRUFBZ0Q7QUFDOUMsYUFBS00sTUFBTCxDQUFZeUUsS0FBWixDQUFrQjFHLFNBQWxCLEVBQTZCLHVCQUF1QjJHLFFBQVFqRixJQUE1RDtBQUNBLGFBQUsyQixRQUFMLENBQWMsSUFBSW1ELEtBQUosQ0FBVUcsUUFBUWpGLElBQWxCLENBQWQ7QUFDQTtBQUNEOztBQUVELFdBQUtULFNBQUwsR0FBaUIsSUFBakI7QUFDQSxXQUFLRyxjQUFMLEdBQXNCLEtBQUt3RyxXQUEzQjtBQUNBLFdBQUtyRixPQUFMLENBQWEsS0FBS3BCLFNBQUwsQ0FBZWdELFVBQTVCO0FBQ0Q7O0FBRUQ7Ozs7Ozs7OztrQ0FNZXdDLE8sRUFBUztBQUN0QixVQUFJNkMsSUFBSjs7QUFFQSxVQUFJLEtBQUtsSixPQUFMLENBQWFnSSxJQUFqQixFQUF1QjtBQUNyQjtBQUNBOztBQUVBa0IsZUFBTyxLQUFLckksU0FBTCxDQUFlaUQsYUFBZixDQUE2QmdGLEtBQTdCLEVBQVA7QUFDQSxZQUFJLENBQUN6QyxRQUFRakUsT0FBYixFQUFzQjtBQUNwQixlQUFLVCxNQUFMLENBQVl5RSxLQUFaLENBQWtCMUcsU0FBbEIsRUFBNkIsdUJBQXVCd0osSUFBdkIsR0FBOEIsVUFBM0Q7QUFDQSxlQUFLckksU0FBTCxDQUFlZ0QsVUFBZixDQUEwQm1CLElBQTFCLENBQStCa0UsSUFBL0I7QUFDRCxTQUhELE1BR087QUFDTCxlQUFLdkgsTUFBTCxDQUFZeUUsS0FBWixDQUFrQjFHLFNBQWxCLEVBQTZCLHVCQUF1QndKLElBQXZCLEdBQThCLGFBQTNEO0FBQ0Q7O0FBRUQsWUFBSSxLQUFLckksU0FBTCxDQUFlaUQsYUFBZixDQUE2QkksTUFBakMsRUFBeUM7QUFDdkMsZUFBS3BELGNBQUwsR0FBc0IsS0FBS3NELGFBQTNCO0FBQ0E7QUFDRDs7QUFFRCxhQUFLdEQsY0FBTCxHQUFzQixLQUFLd0csV0FBM0I7QUFDQSxhQUFLbkYsTUFBTCxDQUFZLElBQVo7QUFDRCxPQW5CRCxNQW1CTztBQUNMO0FBQ0E7O0FBRUEsWUFBSSxDQUFDa0UsUUFBUWpFLE9BQWIsRUFBc0I7QUFDcEIsZUFBS1QsTUFBTCxDQUFZeUUsS0FBWixDQUFrQjFHLFNBQWxCLEVBQTZCLHlCQUE3QjtBQUNELFNBRkQsTUFFTztBQUNMLGVBQUtpQyxNQUFMLENBQVl3QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsNEJBQTdCO0FBQ0Q7O0FBRUQsYUFBS29CLGNBQUwsR0FBc0IsS0FBS3dHLFdBQTNCO0FBQ0EsYUFBS25GLE1BQUwsQ0FBWSxDQUFDLENBQUNrRSxRQUFRakUsT0FBdEI7QUFDRDs7QUFFRDtBQUNBLFVBQUksS0FBS3RCLGNBQUwsS0FBd0IsS0FBS3dHLFdBQWpDLEVBQThDO0FBQzVDO0FBQ0EsYUFBSzNGLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2Qiw2Q0FBN0I7QUFDQSxhQUFLc0MsTUFBTDtBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7Ozs7dUNBT29CNEYsSSxFQUFNdUIsSyxFQUFPO0FBQy9CLFVBQUlDLFdBQVcsQ0FDYixXQUFXeEIsUUFBUSxFQUFuQixDQURhLEVBRWIsaUJBQWlCdUIsS0FGSixFQUdiLEVBSGEsRUFJYixFQUphLENBQWY7QUFNQTtBQUNBLGFBQU8seUJBQU9DLFNBQVNqRSxJQUFULENBQWMsTUFBZCxDQUFQLENBQVA7QUFDRDs7Ozs7O2tCQUdZdEYsVSIsImZpbGUiOiJjbGllbnQuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBjYW1lbGNhc2UgKi9cblxuaW1wb3J0IHsgZW5jb2RlIH0gZnJvbSAnZW1haWxqcy1iYXNlNjQnXG5pbXBvcnQgVENQU29ja2V0IGZyb20gJ2VtYWlsanMtdGNwLXNvY2tldCdcbmltcG9ydCB7IFRleHREZWNvZGVyLCBUZXh0RW5jb2RlciB9IGZyb20gJ3RleHQtZW5jb2RpbmcnXG5cbnZhciBERUJVR19UQUcgPSAnU01UUCBDbGllbnQnXG5cbi8qKlxuICogTG93ZXIgQm91bmQgZm9yIHNvY2tldCB0aW1lb3V0IHRvIHdhaXQgc2luY2UgdGhlIGxhc3QgZGF0YSB3YXMgd3JpdHRlbiB0byBhIHNvY2tldFxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCA9IDEwMDAwXG5cbi8qKlxuICogTXVsdGlwbGllciBmb3Igc29ja2V0IHRpbWVvdXQ6XG4gKlxuICogV2UgYXNzdW1lIGF0IGxlYXN0IGEgR1BSUyBjb25uZWN0aW9uIHdpdGggMTE1IGtiL3MgPSAxNCwzNzUga0IvcyB0b3BzLCBzbyAxMCBLQi9zIHRvIGJlIG9uXG4gKiB0aGUgc2FmZSBzaWRlLiBXZSBjYW4gdGltZW91dCBhZnRlciBhIGxvd2VyIGJvdW5kIG9mIDEwcyArIChuIEtCIC8gMTAgS0IvcykuIEEgMSBNQiBtZXNzYWdlXG4gKiB1cGxvYWQgd291bGQgYmUgMTEwIHNlY29uZHMgdG8gd2FpdCBmb3IgdGhlIHRpbWVvdXQuIDEwIEtCL3MgPT09IDAuMSBzL0JcbiAqL1xuY29uc3QgVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUiA9IDAuMVxuXG5jbGFzcyBTbXRwQ2xpZW50IHtcbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBjb25uZWN0aW9uIG9iamVjdCB0byBhIFNNVFAgc2VydmVyIGFuZCBhbGxvd3MgdG8gc2VuZCBtYWlsIHRocm91Z2ggaXQuXG4gICAqIENhbGwgYGNvbm5lY3RgIG1ldGhvZCB0byBpbml0aXRhdGUgdGhlIGFjdHVhbCBjb25uZWN0aW9uLCB0aGUgY29uc3RydWN0b3Igb25seVxuICAgKiBkZWZpbmVzIHRoZSBwcm9wZXJ0aWVzIGJ1dCBkb2VzIG5vdCBhY3R1YWxseSBjb25uZWN0LlxuICAgKlxuICAgKiBOQiEgVGhlIHBhcmFtZXRlciBvcmRlciAoaG9zdCwgcG9ydCkgZGlmZmVycyBmcm9tIG5vZGUuanMgXCJ3YXlcIiAocG9ydCwgaG9zdClcbiAgICpcbiAgICogQGNvbnN0cnVjdG9yXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbaG9zdD1cImxvY2FsaG9zdFwiXSBIb3N0bmFtZSB0byBjb25lbmN0IHRvXG4gICAqIEBwYXJhbSB7TnVtYmVyfSBbcG9ydD0yNV0gUG9ydCBudW1iZXIgdG8gY29ubmVjdCB0b1xuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0XG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0XSBTZXQgdG8gdHJ1ZSwgdG8gdXNlIGVuY3J5cHRlZCBjb25uZWN0aW9uXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5uYW1lXSBDbGllbnQgaG9zdG5hbWUgZm9yIGludHJvZHVjaW5nIGl0c2VsZiB0byB0aGUgc2VydmVyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9ucy5hdXRoXSBBdXRoZW50aWNhdGlvbiBvcHRpb25zLiBEZXBlbmRzIG9uIHRoZSBwcmVmZXJyZWQgYXV0aGVudGljYXRpb24gbWV0aG9kLiBVc3VhbGx5IHt1c2VyLCBwYXNzfVxuICAgKiBAcGFyYW0ge1N0cmluZ30gW29wdGlvbnMuYXV0aE1ldGhvZF0gRm9yY2Ugc3BlY2lmaWMgYXV0aGVudGljYXRpb24gbWV0aG9kXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMuZGlzYWJsZUVzY2FwaW5nXSBJZiBzZXQgdG8gdHJ1ZSwgZG8gbm90IGVzY2FwZSBkb3RzIG9uIHRoZSBiZWdpbm5pbmcgb2YgdGhlIGxpbmVzXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMubG9nZ2VyXSBBIHdpbnN0b24tY29tcGF0aWJsZSBsb2dnZXJcbiAgICovXG4gIGNvbnN0cnVjdG9yIChob3N0LCBwb3J0LCBvcHRpb25zID0ge30pIHtcbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zXG5cbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kID0gVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyID0gVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUlxuXG4gICAgdGhpcy5wb3J0ID0gcG9ydCB8fCAodGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA/IDQ2NSA6IDI1KVxuICAgIHRoaXMuaG9zdCA9IGhvc3QgfHwgJ2xvY2FsaG9zdCdcblxuICAgIC8qKlxuICAgICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAgICogKHJlY29tbWVuZGVkIGlmIGFwcGxpY2FibGUpLiBJZiB1c2VTZWN1cmVUcmFuc3BvcnQgaXMgbm90IHNldCBidXQgdGhlIHBvcnQgdXNlZCBpcyA0NjUsXG4gICAgICogdGhlbiBlY3J5cHRpb24gaXMgdXNlZCBieSBkZWZhdWx0LlxuICAgICAqL1xuICAgIHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPSAndXNlU2VjdXJlVHJhbnNwb3J0JyBpbiB0aGlzLm9wdGlvbnMgPyAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgOiB0aGlzLnBvcnQgPT09IDQ2NVxuXG4gICAgdGhpcy5vcHRpb25zLmF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aCB8fCBmYWxzZSAvLyBBdXRoZW50aWNhdGlvbiBvYmplY3QuIElmIG5vdCBzZXQsIGF1dGhlbnRpY2F0aW9uIHN0ZXAgd2lsbCBiZSBza2lwcGVkLlxuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCcgLy8gSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLnNvY2tldCA9IGZhbHNlIC8vIERvd25zdHJlYW0gVENQIHNvY2tldCB0byB0aGUgU01UUCBzZXJ2ZXIsIGNyZWF0ZWQgd2l0aCBtb3pUQ1BTb2NrZXRcbiAgICB0aGlzLmRlc3Ryb3llZCA9IGZhbHNlIC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQgYW5kIGNhbid0IGJlIHVzZWQgYW55bW9yZVxuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2UgLy8gS2VlcHMgdHJhY2sgaWYgdGhlIGRvd25zdHJlYW0gc29ja2V0IGlzIGN1cnJlbnRseSBmdWxsIGFuZCBhIGRyYWluIGV2ZW50IHNob3VsZCBiZSB3YWl0ZWQgZm9yIG9yIG5vdFxuXG4gICAgLy8gUHJpdmF0ZSBwcm9wZXJ0aWVzXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSBudWxsIC8vIElmIGF1dGhlbnRpY2F0ZWQgc3VjY2Vzc2Z1bGx5LCBzdG9yZXMgdGhlIHVzZXJuYW1lXG4gICAgdGhpcy5fc3VwcG9ydGVkQXV0aCA9IFtdIC8vIEEgbGlzdCBvZiBhdXRoZW50aWNhdGlvbiBtZWNoYW5pc21zIGRldGVjdGVkIGZyb20gdGhlIEVITE8gcmVzcG9uc2UgYW5kIHdoaWNoIGFyZSBjb21wYXRpYmxlIHdpdGggdGhpcyBsaWJyYXJ5XG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZSAvLyBJZiB0cnVlLCBhY2NlcHRzIGRhdGEgZnJvbSB0aGUgdXBzdHJlYW0gdG8gYmUgcGFzc2VkIGRpcmVjdGx5IHRvIHRoZSBkb3duc3RyZWFtIHNvY2tldC4gVXNlZCBhZnRlciB0aGUgREFUQSBjb21tYW5kXG4gICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9ICcnIC8vIEtlZXAgdHJhY2sgb2YgdGhlIGxhc3QgYnl0ZXMgdG8gc2VlIGhvdyB0aGUgdGVybWluYXRpbmcgZG90IHNob3VsZCBiZSBwbGFjZWRcbiAgICB0aGlzLl9lbnZlbG9wZSA9IG51bGwgLy8gRW52ZWxvcGUgb2JqZWN0IGZvciB0cmFja2luZyB3aG8gaXMgc2VuZGluZyBtYWlsIHRvIHdob21cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gbnVsbCAvLyBTdG9yZXMgdGhlIGZ1bmN0aW9uIHRoYXQgc2hvdWxkIGJlIHJ1biBhZnRlciBhIHJlc3BvbnNlIGhhcyBiZWVuIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgLy8gSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGlzIHNlY3VyZWQgb3IgcGxhaW50ZXh0XG4gICAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gZmFsc2UgLy8gVGltZXIgd2FpdGluZyB0byBkZWNsYXJlIHRoZSBzb2NrZXQgZGVhZCBzdGFydGluZyBmcm9tIHRoZSBsYXN0IHdyaXRlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gZmFsc2UgLy8gU3RhcnQgdGltZSBvZiBzZW5kaW5nIHRoZSBmaXJzdCBwYWNrZXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlIC8vIFRpbWVvdXQgZm9yIHNlbmRpbmcgaW4gZGF0YSBtb2RlLCBnZXRzIGV4dGVuZGVkIHdpdGggZXZlcnkgc2VuZCgpXG5cbiAgICB0aGlzLl9wYXJzZUJsb2NrID0geyBkYXRhOiBbXSwgc3RhdHVzQ29kZTogbnVsbCB9XG4gICAgdGhpcy5fcGFyc2VSZW1haW5kZXIgPSAnJyAvLyBJZiB0aGUgY29tcGxldGUgbGluZSBpcyBub3QgcmVjZWl2ZWQgeWV0LCBjb250YWlucyB0aGUgYmVnaW5uaW5nIG9mIGl0XG5cbiAgICBjb25zdCBkdW1teUxvZ2dlciA9IFsnZXJyb3InLCAnd2FybmluZycsICdpbmZvJywgJ2RlYnVnJ10ucmVkdWNlKChvLCBsKSA9PiB7IG9bbF0gPSAoKSA9PiB7fTsgcmV0dXJuIG8gfSwge30pXG4gICAgdGhpcy5sb2dnZXIgPSBvcHRpb25zLmxvZ2dlciB8fCBkdW1teUxvZ2dlclxuXG4gICAgLy8gRXZlbnQgcGxhY2Vob2xkZXJzXG4gICAgdGhpcy5vbmVycm9yID0gKGUpID0+IHsgfSAvLyBXaWxsIGJlIHJ1biB3aGVuIGFuIGVycm9yIG9jY3Vycy4gVGhlIGBvbmNsb3NlYCBldmVudCB3aWxsIGZpcmUgc3Vic2VxdWVudGx5LlxuICAgIHRoaXMub25kcmFpbiA9ICgpID0+IHsgfSAvLyBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQuXG4gICAgdGhpcy5vbmNsb3NlID0gKCkgPT4geyB9IC8vIFRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaGFzIGJlZW4gY2xvc2VkXG4gICAgdGhpcy5vbmlkbGUgPSAoKSA9PiB7IH0gLy8gVGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQgYW5kIGlkbGUsIHlvdSBjYW4gc2VuZCBtYWlsIG5vd1xuICAgIHRoaXMub25yZWFkeSA9IChmYWlsZWRSZWNpcGllbnRzKSA9PiB7IH0gLy8gV2FpdGluZyBmb3IgbWFpbCBib2R5LCBsaXN0cyBhZGRyZXNzZXMgdGhhdCB3ZXJlIG5vdCBhY2NlcHRlZCBhcyByZWNpcGllbnRzXG4gICAgdGhpcy5vbmRvbmUgPSAoc3VjY2VzcykgPT4geyB9IC8vIFRoZSBtYWlsIGhhcyBiZWVuIHNlbnQuIFdhaXQgZm9yIGBvbmlkbGVgIG5leHQuIEluZGljYXRlcyBpZiB0aGUgbWVzc2FnZSB3YXMgcXVldWVkIGJ5IHRoZSBzZXJ2ZXIuXG4gIH1cblxuICAvKipcbiAgICogSW5pdGlhdGUgYSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNvbm5lY3QgKFNvY2tldENvbnRydWN0b3IgPSBUQ1BTb2NrZXQpIHtcbiAgICB0aGlzLnNvY2tldCA9IFNvY2tldENvbnRydWN0b3Iub3Blbih0aGlzLmhvc3QsIHRoaXMucG9ydCwge1xuICAgICAgYmluYXJ5VHlwZTogJ2FycmF5YnVmZmVyJyxcbiAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogdGhpcy5fc2VjdXJlTW9kZSxcbiAgICAgIGNhOiB0aGlzLm9wdGlvbnMuY2EsXG4gICAgICB0bHNXb3JrZXJQYXRoOiB0aGlzLm9wdGlvbnMudGxzV29ya2VyUGF0aCxcbiAgICAgIHdzOiB0aGlzLm9wdGlvbnMud3NcbiAgICB9KVxuXG4gICAgLy8gYWxsb3dzIGNlcnRpZmljYXRlIGhhbmRsaW5nIGZvciBwbGF0Zm9ybSB3L28gbmF0aXZlIHRscyBzdXBwb3J0XG4gICAgLy8gb25jZXJ0IGlzIG5vbiBzdGFuZGFyZCBzbyBzZXR0aW5nIGl0IG1pZ2h0IHRocm93IGlmIHRoZSBzb2NrZXQgb2JqZWN0IGlzIGltbXV0YWJsZVxuICAgIHRyeSB7XG4gICAgICB0aGlzLnNvY2tldC5vbmNlcnQgPSAoY2VydCkgPT4geyB0aGlzLm9uY2VydCAmJiB0aGlzLm9uY2VydChjZXJ0KSB9XG4gICAgfSBjYXRjaCAoRSkgeyB9XG4gICAgdGhpcy5zb2NrZXQub25lcnJvciA9IHRoaXMuX29uRXJyb3IuYmluZCh0aGlzKVxuICAgIHRoaXMuc29ja2V0Lm9ub3BlbiA9IHRoaXMuX29uT3Blbi5iaW5kKHRoaXMpXG4gIH1cblxuICAvKipcbiAgICogU2VuZHMgUVVJVFxuICAgKi9cbiAgcXVpdCAoKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBRVUlULi4uJylcbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUVVJVCcpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuY2xvc2VcbiAgfVxuXG4gIC8qKlxuICAgKiBDbG9zZXMgdGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgY2xvc2UgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0Nsb3NpbmcgY29ubmVjdGlvbi4uLicpXG4gICAgaWYgKHRoaXMuc29ja2V0ICYmIHRoaXMuc29ja2V0LnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgICAgdGhpcy5zb2NrZXQuY2xvc2UoKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9kZXN0cm95KClcbiAgICB9XG4gIH1cblxuICAvLyBNYWlsIHJlbGF0ZWQgbWV0aG9kc1xuXG4gIC8qKlxuICAgKiBJbml0aWF0ZXMgYSBuZXcgbWVzc2FnZSBieSBzdWJtaXR0aW5nIGVudmVsb3BlIGRhdGEsIHN0YXJ0aW5nIHdpdGhcbiAgICogYE1BSUwgRlJPTTpgIGNvbW1hbmQuIFVzZSBhZnRlciBgb25pZGxlYCBldmVudFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gZW52ZWxvcGUgRW52ZWxvcGUgb2JqZWN0IGluIHRoZSBmb3JtIG9mIHtmcm9tOlwiLi4uXCIsIHRvOltcIi4uLlwiXX1cbiAgICovXG4gIHVzZUVudmVsb3BlIChlbnZlbG9wZSkge1xuICAgIHRoaXMuX2VudmVsb3BlID0gZW52ZWxvcGUgfHwge31cbiAgICB0aGlzLl9lbnZlbG9wZS5mcm9tID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLmZyb20gfHwgKCdhbm9ueW1vdXNAJyArIHRoaXMub3B0aW9ucy5uYW1lKSlbMF1cbiAgICB0aGlzLl9lbnZlbG9wZS50byA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS50byB8fCBbXSlcblxuICAgIC8vIGNsb25lIHRoZSByZWNpcGllbnRzIGFycmF5IGZvciBsYXR0ZXIgbWFuaXB1bGF0aW9uXG4gICAgdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLnRvKVxuICAgIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQgPSBbXVxuICAgIHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUgPSBbXVxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbk1BSUxcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIE1BSUwgRlJPTS4uLicpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ01BSUwgRlJPTTo8JyArICh0aGlzLl9lbnZlbG9wZS5mcm9tKSArICc+JylcbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIEFTQ0lJIGRhdGEgdG8gdGhlIHNlcnZlci4gV29ya3Mgb25seSBpbiBkYXRhIG1vZGUgKGFmdGVyIGBvbnJlYWR5YCBldmVudCksIGlnbm9yZWRcbiAgICogb3RoZXJ3aXNlXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjaHVuayBBU0NJSSBzdHJpbmcgKHF1b3RlZC1wcmludGFibGUsIGJhc2U2NCBldGMuKSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICogQHJldHVybiB7Qm9vbGVhbn0gSWYgdHJ1ZSwgaXQgaXMgc2FmZSB0byBzZW5kIG1vcmUgZGF0YSwgaWYgZmFsc2UsIHlvdSAqc2hvdWxkKiB3YWl0IGZvciB0aGUgb25kcmFpbiBldmVudCBiZWZvcmUgc2VuZGluZyBtb3JlXG4gICAqL1xuICBzZW5kIChjaHVuaykge1xuICAgIC8vIHdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlXG4gICAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgICAgLy8gdGhpcyBsaW5lIHNob3VsZCBuZXZlciBiZSByZWFjaGVkIGJ1dCBpZiBpdCBkb2VzLFxuICAgICAgLy8gYWN0IGxpa2UgZXZlcnl0aGluZydzIG5vcm1hbC5cbiAgICAgIHJldHVybiB0cnVlXG4gICAgfVxuXG4gICAgLy8gVE9ETzogaWYgdGhlIGNodW5rIGlzIGFuIGFycmF5YnVmZmVyLCB1c2UgYSBzZXBhcmF0ZSBmdW5jdGlvbiB0byBzZW5kIHRoZSBkYXRhXG4gICAgcmV0dXJuIHRoaXMuX3NlbmRTdHJpbmcoY2h1bmspXG4gIH1cblxuICAvKipcbiAgICogSW5kaWNhdGVzIHRoYXQgYSBkYXRhIHN0cmVhbSBmb3IgdGhlIHNvY2tldCBpcyBlbmRlZC4gV29ya3Mgb25seSBpbiBkYXRhXG4gICAqIG1vZGUgKGFmdGVyIGBvbnJlYWR5YCBldmVudCksIGlnbm9yZWQgb3RoZXJ3aXNlLiBVc2UgaXQgd2hlbiB5b3UgYXJlIGRvbmVcbiAgICogd2l0aCBzZW5kaW5nIHRoZSBtYWlsLiBUaGlzIG1ldGhvZCBkb2VzIG5vdCBjbG9zZSB0aGUgc29ja2V0LiBPbmNlIHRoZSBtYWlsXG4gICAqIGhhcyBiZWVuIHF1ZXVlZCBieSB0aGUgc2VydmVyLCBgb25kb25lYCBhbmQgYG9uaWRsZWAgYXJlIGVtaXR0ZWQuXG4gICAqXG4gICAqIEBwYXJhbSB7QnVmZmVyfSBbY2h1bmtdIENodW5rIG9mIGRhdGEgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqL1xuICBlbmQgKGNodW5rKSB7XG4gICAgLy8gd29ya3Mgb25seSBpbiBkYXRhIG1vZGVcbiAgICBpZiAoIXRoaXMuX2RhdGFNb2RlKSB7XG4gICAgICAvLyB0aGlzIGxpbmUgc2hvdWxkIG5ldmVyIGJlIHJlYWNoZWQgYnV0IGlmIGl0IGRvZXMsXG4gICAgICAvLyBhY3QgbGlrZSBldmVyeXRoaW5nJ3Mgbm9ybWFsLlxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9XG5cbiAgICBpZiAoY2h1bmsgJiYgY2h1bmsubGVuZ3RoKSB7XG4gICAgICB0aGlzLnNlbmQoY2h1bmspXG4gICAgfVxuXG4gICAgLy8gcmVkaXJlY3Qgb3V0cHV0IGZyb20gdGhlIHNlcnZlciB0byBfYWN0aW9uU3RyZWFtXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblN0cmVhbVxuXG4gICAgLy8gaW5kaWNhdGUgdGhhdCB0aGUgc3RyZWFtIGhhcyBlbmRlZCBieSBzZW5kaW5nIGEgc2luZ2xlIGRvdCBvbiBpdHMgb3duIGxpbmVcbiAgICAvLyBpZiB0aGUgY2xpZW50IGFscmVhZHkgY2xvc2VkIHRoZSBkYXRhIHdpdGggXFxyXFxuIG5vIG5lZWQgdG8gZG8gaXQgYWdhaW5cbiAgICBpZiAodGhpcy5fbGFzdERhdGFCeXRlcyA9PT0gJ1xcclxcbicpIHtcbiAgICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gLlxcclxcblxuICAgIH0gZWxzZSBpZiAodGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpID09PSAnXFxyJykge1xuICAgICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDBBLCAweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyBcXG4uXFxyXFxuXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgwRCwgMHgwQSwgMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gXFxyXFxuLlxcclxcblxuICAgIH1cblxuICAgIC8vIGVuZCBkYXRhIG1vZGUsIHJlc2V0IHRoZSB2YXJpYWJsZXMgZm9yIGV4dGVuZGluZyB0aGUgdGltZW91dCBpbiBkYXRhIG1vZGVcbiAgICB0aGlzLl9kYXRhTW9kZSA9IGZhbHNlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gZmFsc2VcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gZmFsc2VcblxuICAgIHJldHVybiB0aGlzLndhaXREcmFpblxuICB9XG5cbiAgLy8gUFJJVkFURSBNRVRIT0RTXG5cbiAgLyoqXG4gICAqIFF1ZXVlIHNvbWUgZGF0YSBmcm9tIHRoZSBzZXJ2ZXIgZm9yIHBhcnNpbmcuXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjaHVuayBDaHVuayBvZiBkYXRhIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgX3BhcnNlIChjaHVuaykge1xuICAgIC8vIExpbmVzIHNob3VsZCBhbHdheXMgZW5kIHdpdGggPENSPjxMRj4gYnV0IHlvdSBuZXZlciBrbm93LCBtaWdodCBiZSBvbmx5IDxMRj4gYXMgd2VsbFxuICAgIHZhciBsaW5lcyA9ICh0aGlzLl9wYXJzZVJlbWFpbmRlciArIChjaHVuayB8fCAnJykpLnNwbGl0KC9cXHI/XFxuLylcbiAgICB0aGlzLl9wYXJzZVJlbWFpbmRlciA9IGxpbmVzLnBvcCgpIC8vIG5vdCBzdXJlIGlmIHRoZSBsaW5lIGhhcyBjb21wbGV0ZWx5IGFycml2ZWQgeWV0XG5cbiAgICBmb3IgKGxldCBpID0gMCwgbGVuID0gbGluZXMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgIGlmICghbGluZXNbaV0udHJpbSgpKSB7XG4gICAgICAgIC8vIG5vdGhpbmcgdG8gY2hlY2ssIGVtcHR5IGxpbmVcbiAgICAgICAgY29udGludWVcbiAgICAgIH1cblxuICAgICAgLy8gcG9zc2libGUgaW5wdXQgc3RyaW5ncyBmb3IgdGhlIHJlZ2V4OlxuICAgICAgLy8gMjUwLU1VTFRJTElORSBSRVBMWVxuICAgICAgLy8gMjUwIExBU1QgTElORSBPRiBSRVBMWVxuICAgICAgLy8gMjUwIDEuMi4zIE1FU1NBR0VcblxuICAgICAgY29uc3QgbWF0Y2ggPSBsaW5lc1tpXS5tYXRjaCgvXihcXGR7M30pKFstIF0pKD86KFxcZCtcXC5cXGQrXFwuXFxkKykoPzogKSk/KC4qKS8pXG5cbiAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICB0aGlzLl9wYXJzZUJsb2NrLmRhdGEucHVzaChtYXRjaFs0XSlcblxuICAgICAgICBpZiAobWF0Y2hbMl0gPT09ICctJykge1xuICAgICAgICAgIC8vIHRoaXMgaXMgYSBtdWx0aWxpbmUgcmVwbHlcbiAgICAgICAgICB0aGlzLl9wYXJzZUJsb2NrLnN0YXR1c0NvZGUgPSB0aGlzLl9wYXJzZUJsb2NrLnN0YXR1c0NvZGUgfHwgTnVtYmVyKG1hdGNoWzFdKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IHN0YXR1c0NvZGUgPSBOdW1iZXIobWF0Y2hbMV0pIHx8IDBcbiAgICAgICAgICBjb25zdCByZXNwb25zZSA9IHtcbiAgICAgICAgICAgIHN0YXR1c0NvZGUsXG4gICAgICAgICAgICBkYXRhOiB0aGlzLl9wYXJzZUJsb2NrLmRhdGEuam9pbignXFxuJyksXG4gICAgICAgICAgICBzdWNjZXNzOiBzdGF0dXNDb2RlID49IDIwMCAmJiBzdGF0dXNDb2RlIDwgMzAwXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdGhpcy5fb25Db21tYW5kKHJlc3BvbnNlKVxuICAgICAgICAgIHRoaXMuX3BhcnNlQmxvY2sgPSB7XG4gICAgICAgICAgICBkYXRhOiBbXSxcbiAgICAgICAgICAgIHN0YXR1c0NvZGU6IG51bGxcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX29uQ29tbWFuZCh7XG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgc3RhdHVzQ29kZTogdGhpcy5fcGFyc2VCbG9jay5zdGF0dXNDb2RlIHx8IG51bGwsXG4gICAgICAgICAgZGF0YTogW2xpbmVzW2ldXS5qb2luKCdcXG4nKVxuICAgICAgICB9KVxuICAgICAgICB0aGlzLl9wYXJzZUJsb2NrID0ge1xuICAgICAgICAgIGRhdGE6IFtdLFxuICAgICAgICAgIHN0YXR1c0NvZGU6IG51bGxcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIEVWRU5UIEhBTkRMRVJTIEZPUiBUSEUgU09DS0VUXG5cbiAgLyoqXG4gICAqIENvbm5lY3Rpb24gbGlzdGVuZXIgdGhhdCBpcyBydW4gd2hlbiB0aGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyIGlzIG9wZW5lZC5cbiAgICogU2V0cyB1cCBkaWZmZXJlbnQgZXZlbnQgaGFuZGxlcnMgZm9yIHRoZSBvcGVuZWQgc29ja2V0XG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uT3BlbiAoZXZlbnQpIHtcbiAgICBpZiAoZXZlbnQgJiYgZXZlbnQuZGF0YSAmJiBldmVudC5kYXRhLnByb3h5SG9zdG5hbWUpIHtcbiAgICAgIHRoaXMub3B0aW9ucy5uYW1lID0gZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lXG4gICAgfVxuXG4gICAgdGhpcy5zb2NrZXQub25kYXRhID0gdGhpcy5fb25EYXRhLmJpbmQodGhpcylcblxuICAgIHRoaXMuc29ja2V0Lm9uY2xvc2UgPSB0aGlzLl9vbkNsb3NlLmJpbmQodGhpcylcbiAgICB0aGlzLnNvY2tldC5vbmRyYWluID0gdGhpcy5fb25EcmFpbi5iaW5kKHRoaXMpXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uR3JlZXRpbmdcbiAgfVxuXG4gIC8qKlxuICAgKiBEYXRhIGxpc3RlbmVyIGZvciBjaHVua3Mgb2YgZGF0YSBlbWl0dGVkIGJ5IHRoZSBzZXJ2ZXJcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIFNlZSBgZXZ0LmRhdGFgIGZvciB0aGUgY2h1bmsgcmVjZWl2ZWRcbiAgICovXG4gIF9vbkRhdGEgKGV2dCkge1xuICAgIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpXG4gICAgdmFyIHN0cmluZ1BheWxvYWQgPSBuZXcgVGV4dERlY29kZXIoJ1VURi04JykuZGVjb2RlKG5ldyBVaW50OEFycmF5KGV2dC5kYXRhKSlcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTRVJWRVI6ICcgKyBzdHJpbmdQYXlsb2FkKVxuICAgIHRoaXMuX3BhcnNlKHN0cmluZ1BheWxvYWQpXG4gIH1cblxuICAvKipcbiAgICogTW9yZSBkYXRhIGNhbiBiZSBidWZmZXJlZCBpbiB0aGUgc29ja2V0LCBgd2FpdERyYWluYCBpcyByZXNldCB0byBmYWxzZVxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAgICovXG4gIF9vbkRyYWluICgpIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IGZhbHNlXG4gICAgdGhpcy5vbmRyYWluKClcbiAgfVxuXG4gIC8qKlxuICAgKiBFcnJvciBoYW5kbGVyIGZvciB0aGUgc29ja2V0XG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBTZWUgZXZ0LmRhdGEgZm9yIHRoZSBlcnJvclxuICAgKi9cbiAgX29uRXJyb3IgKGV2dCkge1xuICAgIGlmIChldnQgaW5zdGFuY2VvZiBFcnJvciAmJiBldnQubWVzc2FnZSkge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBldnQpXG4gICAgICB0aGlzLm9uZXJyb3IoZXZ0KVxuICAgIH0gZWxzZSBpZiAoZXZ0ICYmIGV2dC5kYXRhIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXZ0LmRhdGEpXG4gICAgICB0aGlzLm9uZXJyb3IoZXZ0LmRhdGEpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgbmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICAgICAgdGhpcy5vbmVycm9yKG5ldyBFcnJvcigoZXZ0ICYmIGV2dC5kYXRhICYmIGV2dC5kYXRhLm1lc3NhZ2UpIHx8IGV2dC5kYXRhIHx8IGV2dCB8fCAnRXJyb3InKSlcbiAgICB9XG5cbiAgICB0aGlzLmNsb3NlKClcbiAgfVxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZXMgdGhhdCB0aGUgc29ja2V0IGhhcyBiZWVuIGNsb3NlZFxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAgICovXG4gIF9vbkNsb3NlICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTb2NrZXQgY2xvc2VkLicpXG4gICAgdGhpcy5fZGVzdHJveSgpXG4gIH1cblxuICAvKipcbiAgICogVGhpcyBpcyBub3QgYSBzb2NrZXQgZGF0YSBoYW5kbGVyIGJ1dCB0aGUgaGFuZGxlciBmb3IgZGF0YSBlbWl0dGVkIGJ5IHRoZSBwYXJzZXIsXG4gICAqIHNvIHRoaXMgZGF0YSBpcyBzYWZlIHRvIHVzZSBhcyBpdCBpcyBhbHdheXMgY29tcGxldGUgKHNlcnZlciBtaWdodCBzZW5kIHBhcnRpYWwgY2h1bmtzKVxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGRhdGFcbiAgICovXG4gIF9vbkNvbW1hbmQgKGNvbW1hbmQpIHtcbiAgICBpZiAodHlwZW9mIHRoaXMuX2N1cnJlbnRBY3Rpb24gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24oY29tbWFuZClcbiAgICB9XG4gIH1cblxuICBfb25UaW1lb3V0ICgpIHtcbiAgICAvLyBpbmZvcm0gYWJvdXQgdGhlIHRpbWVvdXQgYW5kIHNodXQgZG93blxuICAgIHZhciBlcnJvciA9IG5ldyBFcnJvcignU29ja2V0IHRpbWVkIG91dCEnKVxuICAgIHRoaXMuX29uRXJyb3IoZXJyb3IpXG4gIH1cblxuICAvKipcbiAgICogRW5zdXJlcyB0aGF0IHRoZSBjb25uZWN0aW9uIGlzIGNsb3NlZCBhbmQgc3VjaFxuICAgKi9cbiAgX2Rlc3Ryb3kgKCkge1xuICAgIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpXG5cbiAgICBpZiAoIXRoaXMuZGVzdHJveWVkKSB7XG4gICAgICB0aGlzLmRlc3Ryb3llZCA9IHRydWVcbiAgICAgIHRoaXMub25jbG9zZSgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmRzIGEgc3RyaW5nIHRvIHRoZSBzb2NrZXQuXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjaHVuayBBU0NJSSBzdHJpbmcgKHF1b3RlZC1wcmludGFibGUsIGJhc2U2NCBldGMuKSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICogQHJldHVybiB7Qm9vbGVhbn0gSWYgdHJ1ZSwgaXQgaXMgc2FmZSB0byBzZW5kIG1vcmUgZGF0YSwgaWYgZmFsc2UsIHlvdSAqc2hvdWxkKiB3YWl0IGZvciB0aGUgb25kcmFpbiBldmVudCBiZWZvcmUgc2VuZGluZyBtb3JlXG4gICAqL1xuICBfc2VuZFN0cmluZyAoY2h1bmspIHtcbiAgICAvLyBlc2NhcGUgZG90c1xuICAgIGlmICghdGhpcy5vcHRpb25zLmRpc2FibGVFc2NhcGluZykge1xuICAgICAgY2h1bmsgPSBjaHVuay5yZXBsYWNlKC9cXG5cXC4vZywgJ1xcbi4uJylcbiAgICAgIGlmICgodGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpID09PSAnXFxuJyB8fCAhdGhpcy5fbGFzdERhdGFCeXRlcykgJiYgY2h1bmsuY2hhckF0KDApID09PSAnLicpIHtcbiAgICAgICAgY2h1bmsgPSAnLicgKyBjaHVua1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEtlZXBpbmcgZXllIG9uIHRoZSBsYXN0IGJ5dGVzIHNlbnQsIHRvIHNlZSBpZiB0aGVyZSBpcyBhIDxDUj48TEY+IHNlcXVlbmNlXG4gICAgLy8gYXQgdGhlIGVuZCB3aGljaCBpcyBuZWVkZWQgdG8gZW5kIHRoZSBkYXRhIHN0cmVhbVxuICAgIGlmIChjaHVuay5sZW5ndGggPiAyKSB7XG4gICAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gY2h1bmsuc3Vic3RyKC0yKVxuICAgIH0gZWxzZSBpZiAoY2h1bmsubGVuZ3RoID09PSAxKSB7XG4gICAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gdGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpICsgY2h1bmtcbiAgICB9XG5cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nICcgKyBjaHVuay5sZW5ndGggKyAnIGJ5dGVzIG9mIHBheWxvYWQnKVxuXG4gICAgLy8gcGFzcyB0aGUgY2h1bmsgdG8gdGhlIHNvY2tldFxuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVGV4dEVuY29kZXIoJ1VURi04JykuZW5jb2RlKGNodW5rKS5idWZmZXIpXG4gICAgcmV0dXJuIHRoaXMud2FpdERyYWluXG4gIH1cblxuICAvKipcbiAgICogU2VuZCBhIHN0cmluZyBjb21tYW5kIHRvIHRoZSBzZXJ2ZXIsIGFsc28gYXBwZW5kIFxcclxcbiBpZiBuZWVkZWRcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHN0ciBTdHJpbmcgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqL1xuICBfc2VuZENvbW1hbmQgKHN0cikge1xuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVGV4dEVuY29kZXIoJ1VURi04JykuZW5jb2RlKHN0ciArIChzdHIuc3Vic3RyKC0yKSAhPT0gJ1xcclxcbicgPyAnXFxyXFxuJyA6ICcnKSkuYnVmZmVyKVxuICB9XG5cbiAgX3NlbmQgKGJ1ZmZlcikge1xuICAgIHRoaXMuX3NldFRpbWVvdXQoYnVmZmVyLmJ5dGVMZW5ndGgpXG4gICAgcmV0dXJuIHRoaXMuc29ja2V0LnNlbmQoYnVmZmVyKVxuICB9XG5cbiAgX3NldFRpbWVvdXQgKGJ5dGVMZW5ndGgpIHtcbiAgICB2YXIgcHJvbG9uZ1BlcmlvZCA9IE1hdGguZmxvb3IoYnl0ZUxlbmd0aCAqIHRoaXMudGltZW91dFNvY2tldE11bHRpcGxpZXIpXG4gICAgdmFyIHRpbWVvdXRcblxuICAgIGlmICh0aGlzLl9kYXRhTW9kZSkge1xuICAgICAgLy8gd2UncmUgaW4gZGF0YSBtb2RlLCBzbyB3ZSBjb3VudCBvbmx5IG9uZSB0aW1lb3V0IHRoYXQgZ2V0IGV4dGVuZGVkIGZvciBldmVyeSBzZW5kKCkuXG4gICAgICB2YXIgbm93ID0gRGF0ZS5ub3coKVxuXG4gICAgICAvLyB0aGUgb2xkIHRpbWVvdXQgc3RhcnQgdGltZVxuICAgICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0IHx8IG5vd1xuXG4gICAgICAvLyB0aGUgb2xkIHRpbWVvdXQgcGVyaW9kLCBub3JtYWxpemVkIHRvIGEgbWluaW11bSBvZiBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORFxuICAgICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9ICh0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kIHx8IHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQpICsgcHJvbG9uZ1BlcmlvZFxuXG4gICAgICAvLyB0aGUgbmV3IHRpbWVvdXQgaXMgdGhlIGRlbHRhIGJldHdlZW4gdGhlIG5ldyBmaXJpbmcgdGltZSAoPSB0aW1lb3V0IHBlcmlvZCArIHRpbWVvdXQgc3RhcnQgdGltZSkgYW5kIG5vd1xuICAgICAgdGltZW91dCA9IHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCArIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgLSBub3dcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gc2V0IG5ldyB0aW1vdXRcbiAgICAgIHRpbWVvdXQgPSB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kICsgcHJvbG9uZ1BlcmlvZFxuICAgIH1cblxuICAgIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpIC8vIGNsZWFyIHBlbmRpbmcgdGltZW91dHNcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIgPSBzZXRUaW1lb3V0KHRoaXMuX29uVGltZW91dC5iaW5kKHRoaXMpLCB0aW1lb3V0KSAvLyBhcm0gdGhlIG5leHQgdGltZW91dFxuICB9XG5cbiAgLyoqXG4gICAqIEludGl0aWF0ZSBhdXRoZW50aWNhdGlvbiBzZXF1ZW5jZSBpZiBuZWVkZWRcbiAgICovXG4gIF9hdXRoZW50aWNhdGVVc2VyICgpIHtcbiAgICBpZiAoIXRoaXMub3B0aW9ucy5hdXRoKSB7XG4gICAgICAvLyBubyBuZWVkIHRvIGF1dGhlbnRpY2F0ZSwgYXQgbGVhc3Qgbm8gZGF0YSBnaXZlblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHZhciBhdXRoXG5cbiAgICBpZiAoIXRoaXMub3B0aW9ucy5hdXRoTWV0aG9kICYmIHRoaXMub3B0aW9ucy5hdXRoLnhvYXV0aDIpIHtcbiAgICAgIHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kID0gJ1hPQVVUSDInXG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kKSB7XG4gICAgICBhdXRoID0gdGhpcy5vcHRpb25zLmF1dGhNZXRob2QudG9VcHBlckNhc2UoKS50cmltKClcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gdXNlIGZpcnN0IHN1cHBvcnRlZFxuICAgICAgYXV0aCA9ICh0aGlzLl9zdXBwb3J0ZWRBdXRoWzBdIHx8ICdQTEFJTicpLnRvVXBwZXJDYXNlKCkudHJpbSgpXG4gICAgfVxuXG4gICAgc3dpdGNoIChhdXRoKSB7XG4gICAgICBjYXNlICdMT0dJTic6XG4gICAgICAgIC8vIExPR0lOIGlzIGEgMyBzdGVwIGF1dGhlbnRpY2F0aW9uIHByb2Nlc3NcbiAgICAgICAgLy8gQzogQVVUSCBMT0dJTlxuICAgICAgICAvLyBDOiBCQVNFNjQoVVNFUilcbiAgICAgICAgLy8gQzogQkFTRTY0KFBBU1MpXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIExPR0lOJylcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfTE9HSU5fVVNFUlxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnQVVUSCBMT0dJTicpXG4gICAgICAgIHJldHVyblxuICAgICAgY2FzZSAnUExBSU4nOlxuICAgICAgICAvLyBBVVRIIFBMQUlOIGlzIGEgMSBzdGVwIGF1dGhlbnRpY2F0aW9uIHByb2Nlc3NcbiAgICAgICAgLy8gQzogQVVUSCBQTEFJTiBCQVNFNjQoXFwwIFVTRVIgXFwwIFBBU1MpXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIFBMQUlOJylcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZChcbiAgICAgICAgICAvLyBjb252ZXJ0IHRvIEJBU0U2NFxuICAgICAgICAgICdBVVRIIFBMQUlOICcgK1xuICAgICAgICAgIGVuY29kZShcbiAgICAgICAgICAgIC8vIHRoaXMub3B0aW9ucy5hdXRoLnVzZXIrJ1xcdTAwMDAnK1xuICAgICAgICAgICAgJ1xcdTAwMDAnICsgLy8gc2tpcCBhdXRob3JpemF0aW9uIGlkZW50aXR5IGFzIGl0IGNhdXNlcyBwcm9ibGVtcyB3aXRoIHNvbWUgc2VydmVyc1xuICAgICAgICAgICAgdGhpcy5vcHRpb25zLmF1dGgudXNlciArICdcXHUwMDAwJyArXG4gICAgICAgICAgICB0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKVxuICAgICAgICApXG4gICAgICAgIHJldHVyblxuICAgICAgY2FzZSAnWE9BVVRIMic6XG4gICAgICAgIC8vIFNlZSBodHRwczovL2RldmVsb3BlcnMuZ29vZ2xlLmNvbS9nbWFpbC94b2F1dGgyX3Byb3RvY29sI3NtdHBfcHJvdG9jb2xfZXhjaGFuZ2VcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggWE9BVVRIMicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX1hPQVVUSDJcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0FVVEggWE9BVVRIMiAnICsgdGhpcy5fYnVpbGRYT0F1dGgyVG9rZW4odGhpcy5vcHRpb25zLmF1dGgudXNlciwgdGhpcy5vcHRpb25zLmF1dGgueG9hdXRoMikpXG4gICAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdVbmtub3duIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCAnICsgYXV0aCkpXG4gIH1cblxuICAvLyBBQ1RJT05TIEZPUiBSRVNQT05TRVMgRlJPTSBUSEUgU01UUCBTRVJWRVJcblxuICAvKipcbiAgICogSW5pdGlhbCByZXNwb25zZSBmcm9tIHRoZSBzZXJ2ZXIsIG11c3QgaGF2ZSBhIHN0YXR1cyAyMjBcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkdyZWV0aW5nIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMjIwKSB7XG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBncmVldGluZzogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmxtdHApIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgTEhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25MSExPXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnTEhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIExITE9cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkxITE8gKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTEhMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gUHJvY2VzcyBhcyBFSExPIHJlc3BvbnNlXG4gICAgdGhpcy5fYWN0aW9uRUhMTyhjb21tYW5kKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEVITE8uIElmIHRoZSByZXNwb25zZSBpcyBhbiBlcnJvciwgdHJ5IEhFTE8gaW5zdGVhZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uRUhMTyAoY29tbWFuZCkge1xuICAgIHZhciBtYXRjaFxuXG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIGlmICghdGhpcy5fc2VjdXJlTW9kZSAmJiB0aGlzLm9wdGlvbnMucmVxdWlyZVRMUykge1xuICAgICAgICB2YXIgZXJyTXNnID0gJ1NUQVJUVExTIG5vdCBzdXBwb3J0ZWQgd2l0aG91dCBFSExPJ1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGVyck1zZylcbiAgICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoZXJyTXNnKSlcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIC8vIFRyeSBIRUxPIGluc3RlYWRcbiAgICAgIHRoaXMubG9nZ2VyLndhcm5pbmcoREVCVUdfVEFHLCAnRUhMTyBub3Qgc3VjY2Vzc2Z1bCwgdHJ5aW5nIEhFTE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkhFTE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdIRUxPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFBMQUlOIGF1dGhcbiAgICBpZiAoY29tbWFuZC5kYXRhLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspUExBSU4vaSkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIFBMQUlOJylcbiAgICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnUExBSU4nKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIExPR0lOIGF1dGhcbiAgICBpZiAoY29tbWFuZC5kYXRhLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspTE9HSU4vaSkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIExPR0lOJylcbiAgICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnTE9HSU4nKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFhPQVVUSDIgYXV0aFxuICAgIGlmIChjb21tYW5kLmRhdGEubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylYT0FVVEgyL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBYT0FVVEgyJylcbiAgICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnWE9BVVRIMicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IG1heGltdW0gYWxsb3dlZCBtZXNzYWdlIHNpemVcbiAgICBpZiAoKG1hdGNoID0gY29tbWFuZC5kYXRhLm1hdGNoKC9TSVpFIChcXGQrKS9pKSkgJiYgTnVtYmVyKG1hdGNoWzFdKSkge1xuICAgICAgY29uc3QgbWF4QWxsb3dlZFNpemUgPSBOdW1iZXIobWF0Y2hbMV0pXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNYXhpbXVtIGFsbG93ZCBtZXNzYWdlIHNpemU6ICcgKyBtYXhBbGxvd2VkU2l6ZSlcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBTVEFSVFRMU1xuICAgIGlmICghdGhpcy5fc2VjdXJlTW9kZSkge1xuICAgICAgaWYgKChjb21tYW5kLmRhdGEubWF0Y2goL1NUQVJUVExTXFxzPyQvbWkpICYmICF0aGlzLm9wdGlvbnMuaWdub3JlVExTKSB8fCAhIXRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TVEFSVFRMU1xuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFNUQVJUVExTJylcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1NUQVJUVExTJylcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG4gIH1cblxuICAvKipcbiAgICogSGFuZGxlcyBzZXJ2ZXIgcmVzcG9uc2UgZm9yIFNUQVJUVExTIGNvbW1hbmQuIElmIHRoZXJlJ3MgYW4gZXJyb3JcbiAgICogdHJ5IEhFTE8gaW5zdGVhZCwgb3RoZXJ3aXNlIGluaXRpYXRlIFRMUyB1cGdyYWRlLiBJZiB0aGUgdXBncmFkZVxuICAgKiBzdWNjZWVkZXMgcmVzdGFydCB0aGUgRUhMT1xuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIE1lc3NhZ2UgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICBfYWN0aW9uU1RBUlRUTFMgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnU1RBUlRUTFMgbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSB0cnVlXG4gICAgdGhpcy5zb2NrZXQudXBncmFkZVRvU2VjdXJlKClcblxuICAgIC8vIHJlc3RhcnQgcHJvdG9jb2wgZmxvd1xuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEhFTE9cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkhFTE8gKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnSEVMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4sIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCB1c2VybmFtZVxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9MT0dJTl9VU0VSIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1ZYTmxjbTVoYldVNicpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFZYTmxjbTVoYldVNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBVU0VSIHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1NcbiAgICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgudXNlcikpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBMT0dJTiB1c2VybmFtZSwgaWYgc3VjY2Vzc2Z1bCBleHBlY3RzIGJhc2U2NCBlbmNvZGVkIHBhc3N3b3JkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX0xPR0lOX1BBU1MgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAzMzQgfHwgY29tbWFuZC5kYXRhICE9PSAnVUdGemMzZHZjbVE2Jykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIG5vdCBzdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgbG9naW4gc2VxdWVuY2Ugd2hpbGUgd2FpdGluZyBmb3IgXCIzMzQgVUdGemMzZHZjbVE2IFwiOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBVVRIIExPR0lOIFBBU1Mgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKGVuY29kZSh0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIFhPQVVUSDIgdG9rZW4sIGlmIGVycm9yIG9jY3VycyBzZW5kIGVtcHR5IHJlc3BvbnNlXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX1hPQVVUSDIgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIud2FybmluZyhERUJVR19UQUcsICdFcnJvciBkdXJpbmcgQVVUSCBYT0FVVEgyLCBzZW5kaW5nIGVtcHR5IHJlc3BvbnNlJylcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCcnKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGUoY29tbWFuZClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ2hlY2tzIGlmIGF1dGhlbnRpY2F0aW9uIHN1Y2NlZWRlZCBvciBub3QuIElmIHN1Y2Nlc3NmdWxseSBhdXRoZW50aWNhdGVkXG4gICAqIGVtaXQgYGlkbGVgIHRvIGluZGljYXRlIHRoYXQgYW4gZS1tYWlsIGNhbiBiZSBzZW50IHVzaW5nIHRoaXMgY29ubmVjdGlvblxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSENvbXBsZXRlIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIGZhaWxlZDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBzdWNjZXNzZnVsLicpXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSB0aGlzLm9wdGlvbnMuYXV0aC51c2VyXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbiAgfVxuXG4gIC8qKlxuICAgKiBVc2VkIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgaWRsZSBhbmQgdGhlIHNlcnZlciBlbWl0cyB0aW1lb3V0XG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25JZGxlIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSA+IDMwMCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gTUFJTCBGUk9NIGNvbW1hbmQuIFByb2NlZWQgdG8gZGVmaW5pbmcgUkNQVCBUTyBsaXN0IGlmIHN1Y2Nlc3NmdWxcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbk1BSUwgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHVuc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdDYW5cXCd0IHNlbmQgbWFpbCAtIG5vIHJlY2lwaWVudHMgZGVmaW5lZCcpKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNQUlMIEZST00gc3VjY2Vzc2Z1bCwgcHJvY2VlZGluZyB3aXRoICcgKyB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoICsgJyByZWNpcGllbnRzJylcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gYSBSQ1BUIFRPIGNvbW1hbmQuIElmIHRoZSBjb21tYW5kIGlzIHVuc3VjY2Vzc2Z1bCwgdHJ5IHRoZSBuZXh0IG9uZSxcbiAgICogYXMgdGhpcyBtaWdodCBiZSByZWxhdGVkIG9ubHkgdG8gdGhlIGN1cnJlbnQgcmVjaXBpZW50LCBub3QgYSBnbG9iYWwgZXJyb3IsIHNvXG4gICAqIHRoZSBmb2xsb3dpbmcgcmVjaXBpZW50cyBtaWdodCBzdGlsbCBiZSB2YWxpZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uUkNQVCAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci53YXJuaW5nKERFQlVHX1RBRywgJ1JDUFQgVE8gZmFpbGVkIGZvcjogJyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICAgIC8vIHRoaXMgaXMgYSBzb2Z0IGVycm9yXG4gICAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH1cblxuICAgIGlmICghdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCkge1xuICAgICAgaWYgKHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQubGVuZ3RoIDwgdGhpcy5fZW52ZWxvcGUudG8ubGVuZ3RoKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25EQVRBXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1JDUFQgVE8gZG9uZSwgcHJvY2VlZGluZyB3aXRoIHBheWxvYWQnKVxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnREFUQScpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBhbGwgcmVjaXBpZW50cyB3ZXJlIHJlamVjdGVkJykpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gdGhlIERBVEEgY29tbWFuZC4gU2VydmVyIGlzIG5vdyB3YWl0aW5nIGZvciBhIG1lc3NhZ2UsIHNvIGVtaXQgYG9ucmVhZHlgXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25EQVRBIChjb21tYW5kKSB7XG4gICAgLy8gcmVzcG9uc2Ugc2hvdWxkIGJlIDM1NCBidXQgYWNjb3JkaW5nIHRvIHRoaXMgaXNzdWUgaHR0cHM6Ly9naXRodWIuY29tL2VsZWl0aC9lbWFpbGpzL2lzc3Vlcy8yNFxuICAgIC8vIHNvbWUgc2VydmVycyBtaWdodCB1c2UgMjUwIGluc3RlYWRcbiAgICBpZiAoWzI1MCwgMzU0XS5pbmRleE9mKGNvbW1hbmQuc3RhdHVzQ29kZSkgPCAwKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdEQVRBIHVuc3VjY2Vzc2Z1bCAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX2RhdGFNb2RlID0gdHJ1ZVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgdGhpcy5vbnJlYWR5KHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBvbmNlIHRoZSBtZXNzYWdlIHN0cmVhbSBoYXMgZW5kZWQgd2l0aCA8Q1I+PExGPi48Q1I+PExGPlxuICAgKiBFbWl0cyBgb25kb25lYC5cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvblN0cmVhbSAoY29tbWFuZCkge1xuICAgIHZhciByY3B0XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmxtdHApIHtcbiAgICAgIC8vIExNVFAgcmV0dXJucyBhIHJlc3BvbnNlIGNvZGUgZm9yICpldmVyeSogc3VjY2Vzc2Z1bGx5IHNldCByZWNpcGllbnRcbiAgICAgIC8vIEZvciBldmVyeSByZWNpcGllbnQgdGhlIG1lc3NhZ2UgbWlnaHQgc3VjY2VlZCBvciBmYWlsIGluZGl2aWR1YWxseVxuXG4gICAgICByY3B0ID0gdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5zaGlmdCgpXG4gICAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgZmFpbGVkLicpXG4gICAgICAgIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQucHVzaChyY3B0KVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTG9jYWwgZGVsaXZlcnkgdG8gJyArIHJjcHQgKyAnIHN1Y2NlZWRlZC4nKVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblN0cmVhbVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25kb25lKHRydWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEZvciBTTVRQIHRoZSBtZXNzYWdlIGVpdGhlciBmYWlscyBvciBzdWNjZWVkcywgdGhlcmUgaXMgbm8gaW5mb3JtYXRpb25cbiAgICAgIC8vIGFib3V0IGluZGl2aWR1YWwgcmVjaXBpZW50c1xuXG4gICAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdNZXNzYWdlIHNlbmRpbmcgZmFpbGVkLicpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNZXNzYWdlIHNlbnQgc3VjY2Vzc2Z1bGx5LicpXG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uZG9uZSghIWNvbW1hbmQuc3VjY2VzcylcbiAgICB9XG5cbiAgICAvLyBJZiB0aGUgY2xpZW50IHdhbnRlZCB0byBkbyBzb21ldGhpbmcgZWxzZSAoZWcuIHRvIHF1aXQpLCBkbyBub3QgZm9yY2UgaWRsZVxuICAgIGlmICh0aGlzLl9jdXJyZW50QWN0aW9uID09PSB0aGlzLl9hY3Rpb25JZGxlKSB7XG4gICAgICAvLyBXYWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnNcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0lkbGluZyB3aGlsZSB3YWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnMuLi4nKVxuICAgICAgdGhpcy5vbmlkbGUoKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZHMgYSBsb2dpbiB0b2tlbiBmb3IgWE9BVVRIMiBhdXRoZW50aWNhdGlvbiBjb21tYW5kXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSB1c2VyIEUtbWFpbCBhZGRyZXNzIG9mIHRoZSB1c2VyXG4gICAqIEBwYXJhbSB7U3RyaW5nfSB0b2tlbiBWYWxpZCBhY2Nlc3MgdG9rZW4gZm9yIHRoZSB1c2VyXG4gICAqIEByZXR1cm4ge1N0cmluZ30gQmFzZTY0IGZvcm1hdHRlZCBsb2dpbiB0b2tlblxuICAgKi9cbiAgX2J1aWxkWE9BdXRoMlRva2VuICh1c2VyLCB0b2tlbikge1xuICAgIHZhciBhdXRoRGF0YSA9IFtcbiAgICAgICd1c2VyPScgKyAodXNlciB8fCAnJyksXG4gICAgICAnYXV0aD1CZWFyZXIgJyArIHRva2VuLFxuICAgICAgJycsXG4gICAgICAnJ1xuICAgIF1cbiAgICAvLyBiYXNlNjQoXCJ1c2VyPXtVc2VyfVxceDAwYXV0aD1CZWFyZXIge1Rva2VufVxceDAwXFx4MDBcIilcbiAgICByZXR1cm4gZW5jb2RlKGF1dGhEYXRhLmpvaW4oJ1xceDAxJykpXG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgU210cENsaWVudFxuIl19