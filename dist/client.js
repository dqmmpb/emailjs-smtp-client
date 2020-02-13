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
        ws: this.options.ws,
        timeout: this.options.timeout
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9hdXRoZW50aWNhdGVkQXMiLCJfc3VwcG9ydGVkQXV0aCIsIl9kYXRhTW9kZSIsIl9sYXN0RGF0YUJ5dGVzIiwiX2VudmVsb3BlIiwiX2N1cnJlbnRBY3Rpb24iLCJfc2VjdXJlTW9kZSIsIl9zb2NrZXRUaW1lb3V0VGltZXIiLCJfc29ja2V0VGltZW91dFN0YXJ0IiwiX3NvY2tldFRpbWVvdXRQZXJpb2QiLCJfcGFyc2VCbG9jayIsImRhdGEiLCJzdGF0dXNDb2RlIiwiX3BhcnNlUmVtYWluZGVyIiwiZHVtbXlMb2dnZXIiLCJyZWR1Y2UiLCJvIiwibCIsImxvZ2dlciIsIm9uZXJyb3IiLCJlIiwib25kcmFpbiIsIm9uY2xvc2UiLCJvbmlkbGUiLCJvbnJlYWR5IiwiZmFpbGVkUmVjaXBpZW50cyIsIm9uZG9uZSIsInN1Y2Nlc3MiLCJTb2NrZXRDb250cnVjdG9yIiwiVENQU29ja2V0Iiwib3BlbiIsImJpbmFyeVR5cGUiLCJjYSIsInRsc1dvcmtlclBhdGgiLCJ3cyIsInRpbWVvdXQiLCJvbmNlcnQiLCJjZXJ0IiwiRSIsIl9vbkVycm9yIiwiYmluZCIsIm9ub3BlbiIsIl9vbk9wZW4iLCJkZWJ1ZyIsIl9zZW5kQ29tbWFuZCIsImNsb3NlIiwicmVhZHlTdGF0ZSIsIl9kZXN0cm95IiwiZW52ZWxvcGUiLCJmcm9tIiwiY29uY2F0IiwidG8iLCJyY3B0UXVldWUiLCJyY3B0RmFpbGVkIiwicmVzcG9uc2VRdWV1ZSIsIl9hY3Rpb25NQUlMIiwiY2h1bmsiLCJfc2VuZFN0cmluZyIsImxlbmd0aCIsInNlbmQiLCJfYWN0aW9uU3RyZWFtIiwiX3NlbmQiLCJVaW50OEFycmF5IiwiYnVmZmVyIiwic3Vic3RyIiwibGluZXMiLCJzcGxpdCIsInBvcCIsImkiLCJsZW4iLCJ0cmltIiwibWF0Y2giLCJwdXNoIiwiTnVtYmVyIiwicmVzcG9uc2UiLCJqb2luIiwiX29uQ29tbWFuZCIsImV2ZW50IiwicHJveHlIb3N0bmFtZSIsIm9uZGF0YSIsIl9vbkRhdGEiLCJfb25DbG9zZSIsIl9vbkRyYWluIiwiX2FjdGlvbkdyZWV0aW5nIiwiZXZ0IiwiY2xlYXJUaW1lb3V0Iiwic3RyaW5nUGF5bG9hZCIsIlRleHREZWNvZGVyIiwiZGVjb2RlIiwiX3BhcnNlIiwiRXJyb3IiLCJtZXNzYWdlIiwiZXJyb3IiLCJjb21tYW5kIiwiZGlzYWJsZUVzY2FwaW5nIiwicmVwbGFjZSIsImNoYXJBdCIsIlRleHRFbmNvZGVyIiwiZW5jb2RlIiwic3RyIiwiX3NldFRpbWVvdXQiLCJieXRlTGVuZ3RoIiwicHJvbG9uZ1BlcmlvZCIsIk1hdGgiLCJmbG9vciIsIm5vdyIsIkRhdGUiLCJzZXRUaW1lb3V0IiwiX29uVGltZW91dCIsIl9hY3Rpb25JZGxlIiwiYXV0aE1ldGhvZCIsInhvYXV0aDIiLCJ0b1VwcGVyQ2FzZSIsIl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIiLCJfYWN0aW9uQVVUSENvbXBsZXRlIiwidXNlciIsInBhc3MiLCJfYWN0aW9uQVVUSF9YT0FVVEgyIiwiX2J1aWxkWE9BdXRoMlRva2VuIiwibG10cCIsIl9hY3Rpb25MSExPIiwiX2FjdGlvbkVITE8iLCJyZXF1aXJlVExTIiwiZXJyTXNnIiwid2FybmluZyIsIl9hY3Rpb25IRUxPIiwibWF4QWxsb3dlZFNpemUiLCJpZ25vcmVUTFMiLCJfYWN0aW9uU1RBUlRUTFMiLCJfYXV0aGVudGljYXRlVXNlciIsInVwZ3JhZGVUb1NlY3VyZSIsIl9hY3Rpb25BVVRIX0xPR0lOX1BBU1MiLCJjdXJSZWNpcGllbnQiLCJzaGlmdCIsIl9hY3Rpb25SQ1BUIiwiX2FjdGlvbkRBVEEiLCJpbmRleE9mIiwicmNwdCIsInRva2VuIiwiYXV0aERhdGEiXSwibWFwcGluZ3MiOiI7Ozs7OztxakJBQUE7O0FBRUE7O0FBQ0E7Ozs7QUFDQTs7Ozs7O0FBRUEsSUFBSUEsWUFBWSxhQUFoQjs7QUFFQTs7O0FBR0EsSUFBTUMsNkJBQTZCLEtBQW5DOztBQUVBOzs7Ozs7O0FBT0EsSUFBTUMsNEJBQTRCLEdBQWxDOztJQUVNQyxVO0FBQ0o7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFtQkEsc0JBQWFDLElBQWIsRUFBbUJDLElBQW5CLEVBQXVDO0FBQUEsUUFBZEMsT0FBYyx1RUFBSixFQUFJOztBQUFBOztBQUNyQyxTQUFLQSxPQUFMLEdBQWVBLE9BQWY7O0FBRUEsU0FBS0MsdUJBQUwsR0FBK0JOLDBCQUEvQjtBQUNBLFNBQUtPLHVCQUFMLEdBQStCTix5QkFBL0I7O0FBRUEsU0FBS0csSUFBTCxHQUFZQSxTQUFTLEtBQUtDLE9BQUwsQ0FBYUcsa0JBQWIsR0FBa0MsR0FBbEMsR0FBd0MsRUFBakQsQ0FBWjtBQUNBLFNBQUtMLElBQUwsR0FBWUEsUUFBUSxXQUFwQjs7QUFFQTs7Ozs7QUFLQSxTQUFLRSxPQUFMLENBQWFHLGtCQUFiLEdBQWtDLHdCQUF3QixLQUFLSCxPQUE3QixHQUF1QyxDQUFDLENBQUMsS0FBS0EsT0FBTCxDQUFhRyxrQkFBdEQsR0FBMkUsS0FBS0osSUFBTCxLQUFjLEdBQTNIOztBQUVBLFNBQUtDLE9BQUwsQ0FBYUksSUFBYixHQUFvQixLQUFLSixPQUFMLENBQWFJLElBQWIsSUFBcUIsS0FBekMsQ0FoQnFDLENBZ0JVO0FBQy9DLFNBQUtKLE9BQUwsQ0FBYUssSUFBYixHQUFvQixLQUFLTCxPQUFMLENBQWFLLElBQWIsSUFBcUIsV0FBekMsQ0FqQnFDLENBaUJnQjtBQUNyRCxTQUFLQyxNQUFMLEdBQWMsS0FBZCxDQWxCcUMsQ0FrQmpCO0FBQ3BCLFNBQUtDLFNBQUwsR0FBaUIs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QUFLd0csV0FBM0I7QUFDQSxhQUFLbkYsTUFBTCxDQUFZLElBQVo7QUFDRCxPQW5CRCxNQW1CTztBQUNMO0FBQ0E7O0FBRUEsWUFBSSxDQUFDbUUsUUFBUWxFLE9BQWIsRUFBc0I7QUFDcEIsZUFBS1QsTUFBTCxDQUFZMEUsS0FBWixDQUFrQjNHLFNBQWxCLEVBQTZCLHlCQUE3QjtBQUNELFNBRkQsTUFFTztBQUNMLGVBQUtpQyxNQUFMLENBQVl5QixLQUFaLENBQWtCMUQsU0FBbEIsRUFBNkIsNEJBQTdCO0FBQ0Q7O0FBRUQsYUFBS29CLGNBQUwsR0FBc0IsS0FBS3dHLFdBQTNCO0FBQ0EsYUFBS25GLE1BQUwsQ0FBWSxDQUFDLENBQUNtRSxRQUFRbEUsT0FBdEI7QUFDRDs7QUFFRDtBQUNBLFVBQUksS0FBS3RCLGNBQUwsS0FBd0IsS0FBS3dHLFdBQWpDLEVBQThDO0FBQzVDO0FBQ0EsYUFBSzNGLE1BQUwsQ0FBWXlCLEtBQVosQ0FBa0IxRCxTQUFsQixFQUE2Qiw2Q0FBN0I7QUFDQSxhQUFLc0MsTUFBTDtBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7Ozs7dUNBT29CNEYsSSxFQUFNdUIsSyxFQUFPO0FBQy9CLFVBQUlDLFdBQVcsQ0FDYixXQUFXeEIsUUFBUSxFQUFuQixDQURhLEVBRWIsaUJBQWlCdUIsS0FGSixFQUdiLEVBSGEsRUFJYixFQUphLENBQWY7QUFNQTtBQUNBLGFBQU8seUJBQU9DLFNBQVNoRSxJQUFULENBQWMsTUFBZCxDQUFQLENBQVA7QUFDRDs7Ozs7O2tCQUdZdkYsVSIsImZpbGUiOiJjbGllbnQuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBjYW1lbGNhc2UgKi9cblxuaW1wb3J0IHsgZW5jb2RlIH0gZnJvbSAnZW1haWxqcy1iYXNlNjQnXG5pbXBvcnQgVENQU29ja2V0IGZyb20gJ2VtYWlsanMtdGNwLXNvY2tldCdcbmltcG9ydCB7IFRleHREZWNvZGVyLCBUZXh0RW5jb2RlciB9IGZyb20gJ3RleHQtZW5jb2RpbmcnXG5cbnZhciBERUJVR19UQUcgPSAnU01UUCBDbGllbnQnXG5cbi8qKlxuICogTG93ZXIgQm91bmQgZm9yIHNvY2tldCB0aW1lb3V0IHRvIHdhaXQgc2luY2UgdGhlIGxhc3QgZGF0YSB3YXMgd3JpdHRlbiB0byBhIHNvY2tldFxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCA9IDEwMDAwXG5cbi8qKlxuICogTXVsdGlwbGllciBmb3Igc29ja2V0IHRpbWVvdXQ6XG4gKlxuICogV2UgYXNzdW1lIGF0IGxlYXN0IGEgR1BSUyBjb25uZWN0aW9uIHdpdGggMTE1IGtiL3MgPSAxNCwzNzUga0IvcyB0b3BzLCBzbyAxMCBLQi9zIHRvIGJlIG9uXG4gKiB0aGUgc2FmZSBzaWRlLiBXZSBjYW4gdGltZW91dCBhZnRlciBhIGxvd2VyIGJvdW5kIG9mIDEwcyArIChuIEtCIC8gMTAgS0IvcykuIEEgMSBNQiBtZXNzYWdlXG4gKiB1cGxvYWQgd291bGQgYmUgMTEwIHNlY29uZHMgdG8gd2FpdCBmb3IgdGhlIHRpbWVvdXQuIDEwIEtCL3MgPT09IDAuMSBzL0JcbiAqL1xuY29uc3QgVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUiA9IDAuMVxuXG5jbGFzcyBTbXRwQ2xpZW50IHtcbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBjb25uZWN0aW9uIG9iamVjdCB0byBhIFNNVFAgc2VydmVyIGFuZCBhbGxvd3MgdG8gc2VuZCBtYWlsIHRocm91Z2ggaXQuXG4gICAqIENhbGwgYGNvbm5lY3RgIG1ldGhvZCB0byBpbml0aXRhdGUgdGhlIGFjdHVhbCBjb25uZWN0aW9uLCB0aGUgY29uc3RydWN0b3Igb25seVxuICAgKiBkZWZpbmVzIHRoZSBwcm9wZXJ0aWVzIGJ1dCBkb2VzIG5vdCBhY3R1YWxseSBjb25uZWN0LlxuICAgKlxuICAgKiBOQiEgVGhlIHBhcmFtZXRlciBvcmRlciAoaG9zdCwgcG9ydCkgZGlmZmVycyBmcm9tIG5vZGUuanMgXCJ3YXlcIiAocG9ydCwgaG9zdClcbiAgICpcbiAgICogQGNvbnN0cnVjdG9yXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbaG9zdD1cImxvY2FsaG9zdFwiXSBIb3N0bmFtZSB0byBjb25lbmN0IHRvXG4gICAqIEBwYXJhbSB7TnVtYmVyfSBbcG9ydD0yNV0gUG9ydCBudW1iZXIgdG8gY29ubmVjdCB0b1xuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0XG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0XSBTZXQgdG8gdHJ1ZSwgdG8gdXNlIGVuY3J5cHRlZCBjb25uZWN0aW9uXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5uYW1lXSBDbGllbnQgaG9zdG5hbWUgZm9yIGludHJvZHVjaW5nIGl0c2VsZiB0byB0aGUgc2VydmVyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9ucy5hdXRoXSBBdXRoZW50aWNhdGlvbiBvcHRpb25zLiBEZXBlbmRzIG9uIHRoZSBwcmVmZXJyZWQgYXV0aGVudGljYXRpb24gbWV0aG9kLiBVc3VhbGx5IHt1c2VyLCBwYXNzfVxuICAgKiBAcGFyYW0ge1N0cmluZ30gW29wdGlvbnMuYXV0aE1ldGhvZF0gRm9yY2Ugc3BlY2lmaWMgYXV0aGVudGljYXRpb24gbWV0aG9kXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMuZGlzYWJsZUVzY2FwaW5nXSBJZiBzZXQgdG8gdHJ1ZSwgZG8gbm90IGVzY2FwZSBkb3RzIG9uIHRoZSBiZWdpbm5pbmcgb2YgdGhlIGxpbmVzXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMubG9nZ2VyXSBBIHdpbnN0b24tY29tcGF0aWJsZSBsb2dnZXJcbiAgICovXG4gIGNvbnN0cnVjdG9yIChob3N0LCBwb3J0LCBvcHRpb25zID0ge30pIHtcbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zXG5cbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kID0gVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyID0gVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUlxuXG4gICAgdGhpcy5wb3J0ID0gcG9ydCB8fCAodGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA/IDQ2NSA6IDI1KVxuICAgIHRoaXMuaG9zdCA9IGhvc3QgfHwgJ2xvY2FsaG9zdCdcblxuICAgIC8qKlxuICAgICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAgICogKHJlY29tbWVuZGVkIGlmIGFwcGxpY2FibGUpLiBJZiB1c2VTZWN1cmVUcmFuc3BvcnQgaXMgbm90IHNldCBidXQgdGhlIHBvcnQgdXNlZCBpcyA0NjUsXG4gICAgICogdGhlbiBlY3J5cHRpb24gaXMgdXNlZCBieSBkZWZhdWx0LlxuICAgICAqL1xuICAgIHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPSAndXNlU2VjdXJlVHJhbnNwb3J0JyBpbiB0aGlzLm9wdGlvbnMgPyAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgOiB0aGlzLnBvcnQgPT09IDQ2NVxuXG4gICAgdGhpcy5vcHRpb25zLmF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aCB8fCBmYWxzZSAvLyBBdXRoZW50aWNhdGlvbiBvYmplY3QuIElmIG5vdCBzZXQsIGF1dGhlbnRpY2F0aW9uIHN0ZXAgd2lsbCBiZSBza2lwcGVkLlxuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCcgLy8gSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLnNvY2tldCA9IGZhbHNlIC8vIERvd25zdHJlYW0gVENQIHNvY2tldCB0byB0aGUgU01UUCBzZXJ2ZXIsIGNyZWF0ZWQgd2l0aCBtb3pUQ1BTb2NrZXRcbiAgICB0aGlzLmRlc3Ryb3llZCA9IGZhbHNlIC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQgYW5kIGNhbid0IGJlIHVzZWQgYW55bW9yZVxuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2UgLy8gS2VlcHMgdHJhY2sgaWYgdGhlIGRvd25zdHJlYW0gc29ja2V0IGlzIGN1cnJlbnRseSBmdWxsIGFuZCBhIGRyYWluIGV2ZW50IHNob3VsZCBiZSB3YWl0ZWQgZm9yIG9yIG5vdFxuXG4gICAgLy8gUHJpdmF0ZSBwcm9wZXJ0aWVzXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSBudWxsIC8vIElmIGF1dGhlbnRpY2F0ZWQgc3VjY2Vzc2Z1bGx5LCBzdG9yZXMgdGhlIHVzZXJuYW1lXG4gICAgdGhpcy5fc3VwcG9ydGVkQXV0aCA9IFtdIC8vIEEgbGlzdCBvZiBhdXRoZW50aWNhdGlvbiBtZWNoYW5pc21zIGRldGVjdGVkIGZyb20gdGhlIEVITE8gcmVzcG9uc2UgYW5kIHdoaWNoIGFyZSBjb21wYXRpYmxlIHdpdGggdGhpcyBsaWJyYXJ5XG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZSAvLyBJZiB0cnVlLCBhY2NlcHRzIGRhdGEgZnJvbSB0aGUgdXBzdHJlYW0gdG8gYmUgcGFzc2VkIGRpcmVjdGx5IHRvIHRoZSBkb3duc3RyZWFtIHNvY2tldC4gVXNlZCBhZnRlciB0aGUgREFUQSBjb21tYW5kXG4gICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9ICcnIC8vIEtlZXAgdHJhY2sgb2YgdGhlIGxhc3QgYnl0ZXMgdG8gc2VlIGhvdyB0aGUgdGVybWluYXRpbmcgZG90IHNob3VsZCBiZSBwbGFjZWRcbiAgICB0aGlzLl9lbnZlbG9wZSA9IG51bGwgLy8gRW52ZWxvcGUgb2JqZWN0IGZvciB0cmFja2luZyB3aG8gaXMgc2VuZGluZyBtYWlsIHRvIHdob21cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gbnVsbCAvLyBTdG9yZXMgdGhlIGZ1bmN0aW9uIHRoYXQgc2hvdWxkIGJlIHJ1biBhZnRlciBhIHJlc3BvbnNlIGhhcyBiZWVuIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgLy8gSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGlzIHNlY3VyZWQgb3IgcGxhaW50ZXh0XG4gICAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gZmFsc2UgLy8gVGltZXIgd2FpdGluZyB0byBkZWNsYXJlIHRoZSBzb2NrZXQgZGVhZCBzdGFydGluZyBmcm9tIHRoZSBsYXN0IHdyaXRlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gZmFsc2UgLy8gU3RhcnQgdGltZSBvZiBzZW5kaW5nIHRoZSBmaXJzdCBwYWNrZXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlIC8vIFRpbWVvdXQgZm9yIHNlbmRpbmcgaW4gZGF0YSBtb2RlLCBnZXRzIGV4dGVuZGVkIHdpdGggZXZlcnkgc2VuZCgpXG5cbiAgICB0aGlzLl9wYXJzZUJsb2NrID0geyBkYXRhOiBbXSwgc3RhdHVzQ29kZTogbnVsbCB9XG4gICAgdGhpcy5fcGFyc2VSZW1haW5kZXIgPSAnJyAvLyBJZiB0aGUgY29tcGxldGUgbGluZSBpcyBub3QgcmVjZWl2ZWQgeWV0LCBjb250YWlucyB0aGUgYmVnaW5uaW5nIG9mIGl0XG5cbiAgICBjb25zdCBkdW1teUxvZ2dlciA9IFsnZXJyb3InLCAnd2FybmluZycsICdpbmZvJywgJ2RlYnVnJ10ucmVkdWNlKChvLCBsKSA9PiB7IG9bbF0gPSAoKSA9PiB7fTsgcmV0dXJuIG8gfSwge30pXG4gICAgdGhpcy5sb2dnZXIgPSBvcHRpb25zLmxvZ2dlciB8fCBkdW1teUxvZ2dlclxuXG4gICAgLy8gRXZlbnQgcGxhY2Vob2xkZXJzXG4gICAgdGhpcy5vbmVycm9yID0gKGUpID0+IHsgfSAvLyBXaWxsIGJlIHJ1biB3aGVuIGFuIGVycm9yIG9jY3Vycy4gVGhlIGBvbmNsb3NlYCBldmVudCB3aWxsIGZpcmUgc3Vic2VxdWVudGx5LlxuICAgIHRoaXMub25kcmFpbiA9ICgpID0+IHsgfSAvLyBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQuXG4gICAgdGhpcy5vbmNsb3NlID0gKCkgPT4geyB9IC8vIFRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaGFzIGJlZW4gY2xvc2VkXG4gICAgdGhpcy5vbmlkbGUgPSAoKSA9PiB7IH0gLy8gVGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQgYW5kIGlkbGUsIHlvdSBjYW4gc2VuZCBtYWlsIG5vd1xuICAgIHRoaXMub25yZWFkeSA9IChmYWlsZWRSZWNpcGllbnRzKSA9PiB7IH0gLy8gV2FpdGluZyBmb3IgbWFpbCBib2R5LCBsaXN0cyBhZGRyZXNzZXMgdGhhdCB3ZXJlIG5vdCBhY2NlcHRlZCBhcyByZWNpcGllbnRzXG4gICAgdGhpcy5vbmRvbmUgPSAoc3VjY2VzcykgPT4geyB9IC8vIFRoZSBtYWlsIGhhcyBiZWVuIHNlbnQuIFdhaXQgZm9yIGBvbmlkbGVgIG5leHQuIEluZGljYXRlcyBpZiB0aGUgbWVzc2FnZSB3YXMgcXVldWVkIGJ5IHRoZSBzZXJ2ZXIuXG4gIH1cblxuICAvKipcbiAgICogSW5pdGlhdGUgYSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNvbm5lY3QgKFNvY2tldENvbnRydWN0b3IgPSBUQ1BTb2NrZXQpIHtcbiAgICB0aGlzLnNvY2tldCA9IFNvY2tldENvbnRydWN0b3Iub3Blbih0aGlzLmhvc3QsIHRoaXMucG9ydCwge1xuICAgICAgYmluYXJ5VHlwZTogJ2FycmF5YnVmZmVyJyxcbiAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogdGhpcy5fc2VjdXJlTW9kZSxcbiAgICAgIGNhOiB0aGlzLm9wdGlvbnMuY2EsXG4gICAgICB0bHNXb3JrZXJQYXRoOiB0aGlzLm9wdGlvbnMudGxzV29ya2VyUGF0aCxcbiAgICAgIHdzOiB0aGlzLm9wdGlvbnMud3MsXG4gICAgICB0aW1lb3V0OiB0aGlzLm9wdGlvbnMudGltZW91dFxuICAgIH0pXG5cbiAgICAvLyBhbGxvd3MgY2VydGlmaWNhdGUgaGFuZGxpbmcgZm9yIHBsYXRmb3JtIHcvbyBuYXRpdmUgdGxzIHN1cHBvcnRcbiAgICAvLyBvbmNlcnQgaXMgbm9uIHN0YW5kYXJkIHNvIHNldHRpbmcgaXQgbWlnaHQgdGhyb3cgaWYgdGhlIHNvY2tldCBvYmplY3QgaXMgaW1tdXRhYmxlXG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuc29ja2V0Lm9uY2VydCA9IChjZXJ0KSA9PiB7IHRoaXMub25jZXJ0ICYmIHRoaXMub25jZXJ0KGNlcnQpIH1cbiAgICB9IGNhdGNoIChFKSB7IH1cbiAgICB0aGlzLnNvY2tldC5vbmVycm9yID0gdGhpcy5fb25FcnJvci5iaW5kKHRoaXMpXG4gICAgdGhpcy5zb2NrZXQub25vcGVuID0gdGhpcy5fb25PcGVuLmJpbmQodGhpcylcbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kcyBRVUlUXG4gICAqL1xuICBxdWl0ICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFFVSVQuLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdRVUlUJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5jbG9zZVxuICB9XG5cbiAgLyoqXG4gICAqIENsb3NlcyB0aGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyXG4gICAqL1xuICBjbG9zZSAoKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQ2xvc2luZyBjb25uZWN0aW9uLi4uJylcbiAgICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICB0aGlzLnNvY2tldC5jbG9zZSgpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rlc3Ryb3koKVxuICAgIH1cbiAgfVxuXG4gIC8vIE1haWwgcmVsYXRlZCBtZXRob2RzXG5cbiAgLyoqXG4gICAqIEluaXRpYXRlcyBhIG5ldyBtZXNzYWdlIGJ5IHN1Ym1pdHRpbmcgZW52ZWxvcGUgZGF0YSwgc3RhcnRpbmcgd2l0aFxuICAgKiBgTUFJTCBGUk9NOmAgY29tbWFuZC4gVXNlIGFmdGVyIGBvbmlkbGVgIGV2ZW50XG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBlbnZlbG9wZSBFbnZlbG9wZSBvYmplY3QgaW4gdGhlIGZvcm0gb2Yge2Zyb206XCIuLi5cIiwgdG86W1wiLi4uXCJdfVxuICAgKi9cbiAgdXNlRW52ZWxvcGUgKGVudmVsb3BlKSB7XG4gICAgdGhpcy5fZW52ZWxvcGUgPSBlbnZlbG9wZSB8fCB7fVxuICAgIHRoaXMuX2VudmVsb3BlLmZyb20gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUuZnJvbSB8fCAoJ2Fub255bW91c0AnICsgdGhpcy5vcHRpb25zLm5hbWUpKVswXVxuICAgIHRoaXMuX2VudmVsb3BlLnRvID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLnRvIHx8IFtdKVxuXG4gICAgLy8gY2xvbmUgdGhlIHJlY2lwaWVudHMgYXJyYXkgZm9yIGxhdHRlciBtYW5pcHVsYXRpb25cbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUgPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8pXG4gICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZCA9IFtdXG4gICAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZSA9IFtdXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTUFJTFxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgTUFJTCBGUk9NLi4uJylcbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnTUFJTCBGUk9NOjwnICsgKHRoaXMuX2VudmVsb3BlLmZyb20pICsgJz4nKVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgQVNDSUkgZGF0YSB0byB0aGUgc2VydmVyLiBXb3JrcyBvbmx5IGluIGRhdGEgbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZFxuICAgKiBvdGhlcndpc2VcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAgICovXG4gIHNlbmQgKGNodW5rKSB7XG4gICAgLy8gd29ya3Mgb25seSBpbiBkYXRhIG1vZGVcbiAgICBpZiAoIXRoaXMuX2RhdGFNb2RlKSB7XG4gICAgICAvLyB0aGlzIGxpbmUgc2hvdWxkIG5ldmVyIGJlIHJlYWNoZWQgYnV0IGlmIGl0IGRvZXMsXG4gICAgICAvLyBhY3QgbGlrZSBldmVyeXRoaW5nJ3Mgbm9ybWFsLlxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9XG5cbiAgICAvLyBUT0RPOiBpZiB0aGUgY2h1bmsgaXMgYW4gYXJyYXlidWZmZXIsIHVzZSBhIHNlcGFyYXRlIGZ1bmN0aW9uIHRvIHNlbmQgdGhlIGRhdGFcbiAgICByZXR1cm4gdGhpcy5fc2VuZFN0cmluZyhjaHVuaylcbiAgfVxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZXMgdGhhdCBhIGRhdGEgc3RyZWFtIGZvciB0aGUgc29ja2V0IGlzIGVuZGVkLiBXb3JrcyBvbmx5IGluIGRhdGFcbiAgICogbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZCBvdGhlcndpc2UuIFVzZSBpdCB3aGVuIHlvdSBhcmUgZG9uZVxuICAgKiB3aXRoIHNlbmRpbmcgdGhlIG1haWwuIFRoaXMgbWV0aG9kIGRvZXMgbm90IGNsb3NlIHRoZSBzb2NrZXQuIE9uY2UgdGhlIG1haWxcbiAgICogaGFzIGJlZW4gcXVldWVkIGJ5IHRoZSBzZXJ2ZXIsIGBvbmRvbmVgIGFuZCBgb25pZGxlYCBhcmUgZW1pdHRlZC5cbiAgICpcbiAgICogQHBhcmFtIHtCdWZmZXJ9IFtjaHVua10gQ2h1bmsgb2YgZGF0YSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGVuZCAoY2h1bmspIHtcbiAgICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICAgIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH1cblxuICAgIGlmIChjaHVuayAmJiBjaHVuay5sZW5ndGgpIHtcbiAgICAgIHRoaXMuc2VuZChjaHVuaylcbiAgICB9XG5cbiAgICAvLyByZWRpcmVjdCBvdXRwdXQgZnJvbSB0aGUgc2VydmVyIHRvIF9hY3Rpb25TdHJlYW1cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG5cbiAgICAvLyBpbmRpY2F0ZSB0aGF0IHRoZSBzdHJlYW0gaGFzIGVuZGVkIGJ5IHNlbmRpbmcgYSBzaW5nbGUgZG90IG9uIGl0cyBvd24gbGluZVxuICAgIC8vIGlmIHRoZSBjbGllbnQgYWxyZWFkeSBjbG9zZWQgdGhlIGRhdGEgd2l0aCBcXHJcXG4gbm8gbmVlZCB0byBkbyBpdCBhZ2FpblxuICAgIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzID09PSAnXFxyXFxuJykge1xuICAgICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyAuXFxyXFxuXG4gICAgfSBlbHNlIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXHInKSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcbi5cXHJcXG5cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDBELCAweDBBLCAweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyBcXHJcXG4uXFxyXFxuXG4gICAgfVxuXG4gICAgLy8gZW5kIGRhdGEgbW9kZSwgcmVzZXQgdGhlIHZhcmlhYmxlcyBmb3IgZXh0ZW5kaW5nIHRoZSB0aW1lb3V0IGluIGRhdGEgbW9kZVxuICAgIHRoaXMuX2RhdGFNb2RlID0gZmFsc2VcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSBmYWxzZVxuXG4gICAgcmV0dXJuIHRoaXMud2FpdERyYWluXG4gIH1cblxuICAvLyBQUklWQVRFIE1FVEhPRFNcblxuICAvKipcbiAgICogUXVldWUgc29tZSBkYXRhIGZyb20gdGhlIHNlcnZlciBmb3IgcGFyc2luZy5cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIENodW5rIG9mIGRhdGEgcmVjZWl2ZWQgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICBfcGFyc2UgKGNodW5rKSB7XG4gICAgLy8gTGluZXMgc2hvdWxkIGFsd2F5cyBlbmQgd2l0aCA8Q1I+PExGPiBidXQgeW91IG5ldmVyIGtub3csIG1pZ2h0IGJlIG9ubHkgPExGPiBhcyB3ZWxsXG4gICAgdmFyIGxpbmVzID0gKHRoaXMuX3BhcnNlUmVtYWluZGVyICsgKGNodW5rIHx8ICcnKSkuc3BsaXQoL1xccj9cXG4vKVxuICAgIHRoaXMuX3BhcnNlUmVtYWluZGVyID0gbGluZXMucG9wKCkgLy8gbm90IHN1cmUgaWYgdGhlIGxpbmUgaGFzIGNvbXBsZXRlbHkgYXJyaXZlZCB5ZXRcblxuICAgIGZvciAobGV0IGkgPSAwLCBsZW4gPSBsaW5lcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgICAgaWYgKCFsaW5lc1tpXS50cmltKCkpIHtcbiAgICAgICAgLy8gbm90aGluZyB0byBjaGVjaywgZW1wdHkgbGluZVxuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuXG4gICAgICAvLyBwb3NzaWJsZSBpbnB1dCBzdHJpbmdzIGZvciB0aGUgcmVnZXg6XG4gICAgICAvLyAyNTAtTVVMVElMSU5FIFJFUExZXG4gICAgICAvLyAyNTAgTEFTVCBMSU5FIE9GIFJFUExZXG4gICAgICAvLyAyNTAgMS4yLjMgTUVTU0FHRVxuXG4gICAgICBjb25zdCBtYXRjaCA9IGxpbmVzW2ldLm1hdGNoKC9eKFxcZHszfSkoWy0gXSkoPzooXFxkK1xcLlxcZCtcXC5cXGQrKSg/OiApKT8oLiopLylcblxuICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgIHRoaXMuX3BhcnNlQmxvY2suZGF0YS5wdXNoKG1hdGNoWzRdKVxuXG4gICAgICAgIGlmIChtYXRjaFsyXSA9PT0gJy0nKSB7XG4gICAgICAgICAgLy8gdGhpcyBpcyBhIG11bHRpbGluZSByZXBseVxuICAgICAgICAgIHRoaXMuX3BhcnNlQmxvY2suc3RhdHVzQ29kZSA9IHRoaXMuX3BhcnNlQmxvY2suc3RhdHVzQ29kZSB8fCBOdW1iZXIobWF0Y2hbMV0pXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3Qgc3RhdHVzQ29kZSA9IE51bWJlcihtYXRjaFsxXSkgfHwgMFxuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0ge1xuICAgICAgICAgICAgc3RhdHVzQ29kZSxcbiAgICAgICAgICAgIGRhdGE6IHRoaXMuX3BhcnNlQmxvY2suZGF0YS5qb2luKCdcXG4nKSxcbiAgICAgICAgICAgIHN1Y2Nlc3M6IHN0YXR1c0NvZGUgPj0gMjAwICYmIHN0YXR1c0NvZGUgPCAzMDBcbiAgICAgICAgICB9XG5cbiAgICAgICAgICB0aGlzLl9vbkNvbW1hbmQocmVzcG9uc2UpXG4gICAgICAgICAgdGhpcy5fcGFyc2VCbG9jayA9IHtcbiAgICAgICAgICAgIGRhdGE6IFtdLFxuICAgICAgICAgICAgc3RhdHVzQ29kZTogbnVsbFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5fb25Db21tYW5kKHtcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICBzdGF0dXNDb2RlOiB0aGlzLl9wYXJzZUJsb2NrLnN0YXR1c0NvZGUgfHwgbnVsbCxcbiAgICAgICAgICBkYXRhOiBbbGluZXNbaV1dLmpvaW4oJ1xcbicpXG4gICAgICAgIH0pXG4gICAgICAgIHRoaXMuX3BhcnNlQmxvY2sgPSB7XG4gICAgICAgICAgZGF0YTogW10sXG4gICAgICAgICAgc3RhdHVzQ29kZTogbnVsbFxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gRVZFTlQgSEFORExFUlMgRk9SIFRIRSBTT0NLRVRcblxuICAvKipcbiAgICogQ29ubmVjdGlvbiBsaXN0ZW5lciB0aGF0IGlzIHJ1biB3aGVuIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaXMgb3BlbmVkLlxuICAgKiBTZXRzIHVwIGRpZmZlcmVudCBldmVudCBoYW5kbGVycyBmb3IgdGhlIG9wZW5lZCBzb2NrZXRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gICAqL1xuICBfb25PcGVuIChldmVudCkge1xuICAgIGlmIChldmVudCAmJiBldmVudC5kYXRhICYmIGV2ZW50LmRhdGEucHJveHlIb3N0bmFtZSkge1xuICAgICAgdGhpcy5vcHRpb25zLm5hbWUgPSBldmVudC5kYXRhLnByb3h5SG9zdG5hbWVcbiAgICB9XG5cbiAgICB0aGlzLnNvY2tldC5vbmRhdGEgPSB0aGlzLl9vbkRhdGEuYmluZCh0aGlzKVxuXG4gICAgdGhpcy5zb2NrZXQub25jbG9zZSA9IHRoaXMuX29uQ2xvc2UuYmluZCh0aGlzKVxuICAgIHRoaXMuc29ja2V0Lm9uZHJhaW4gPSB0aGlzLl9vbkRyYWluLmJpbmQodGhpcylcblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25HcmVldGluZ1xuICB9XG5cbiAgLyoqXG4gICAqIERhdGEgbGlzdGVuZXIgZm9yIGNodW5rcyBvZiBkYXRhIGVtaXR0ZWQgYnkgdGhlIHNlcnZlclxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGBldnQuZGF0YWAgZm9yIHRoZSBjaHVuayByZWNlaXZlZFxuICAgKi9cbiAgX29uRGF0YSAoZXZ0KSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcbiAgICB2YXIgc3RyaW5nUGF5bG9hZCA9IG5ldyBUZXh0RGVjb2RlcignVVRGLTgnKS5kZWNvZGUobmV3IFVpbnQ4QXJyYXkoZXZ0LmRhdGEpKVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NFUlZFUjogJyArIHN0cmluZ1BheWxvYWQpXG4gICAgdGhpcy5fcGFyc2Uoc3RyaW5nUGF5bG9hZClcbiAgfVxuXG4gIC8qKlxuICAgKiBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQsIGB3YWl0RHJhaW5gIGlzIHJlc2V0IHRvIGZhbHNlXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uRHJhaW4gKCkge1xuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2VcbiAgICB0aGlzLm9uZHJhaW4oKVxuICB9XG5cbiAgLyoqXG4gICAqIEVycm9yIGhhbmRsZXIgZm9yIHRoZSBzb2NrZXRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIFNlZSBldnQuZGF0YSBmb3IgdGhlIGVycm9yXG4gICAqL1xuICBfb25FcnJvciAoZXZ0KSB7XG4gICAgaWYgKGV2dCBpbnN0YW5jZW9mIEVycm9yICYmIGV2dC5tZXNzYWdlKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dClcbiAgICAgIHRoaXMub25lcnJvcihldnQpXG4gICAgfSBlbHNlIGlmIChldnQgJiYgZXZ0LmRhdGEgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBldnQuZGF0YSlcbiAgICAgIHRoaXMub25lcnJvcihldnQuZGF0YSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBuZXcgRXJyb3IoKGV2dCAmJiBldnQuZGF0YSAmJiBldnQuZGF0YS5tZXNzYWdlKSB8fCBldnQuZGF0YSB8fCBldnQgfHwgJ0Vycm9yJykpXG4gICAgICB0aGlzLm9uZXJyb3IobmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICAgIH1cblxuICAgIHRoaXMuY2xvc2UoKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IHRoZSBzb2NrZXQgaGFzIGJlZW4gY2xvc2VkXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uQ2xvc2UgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NvY2tldCBjbG9zZWQuJylcbiAgICB0aGlzLl9kZXN0cm95KClcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGlzIGlzIG5vdCBhIHNvY2tldCBkYXRhIGhhbmRsZXIgYnV0IHRoZSBoYW5kbGVyIGZvciBkYXRhIGVtaXR0ZWQgYnkgdGhlIHBhcnNlcixcbiAgICogc28gdGhpcyBkYXRhIGlzIHNhZmUgdG8gdXNlIGFzIGl0IGlzIGFsd2F5cyBjb21wbGV0ZSAoc2VydmVyIG1pZ2h0IHNlbmQgcGFydGlhbCBjaHVua3MpXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgZGF0YVxuICAgKi9cbiAgX29uQ29tbWFuZCAoY29tbWFuZCkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5fY3VycmVudEFjdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbihjb21tYW5kKVxuICAgIH1cbiAgfVxuXG4gIF9vblRpbWVvdXQgKCkge1xuICAgIC8vIGluZm9ybSBhYm91dCB0aGUgdGltZW91dCBhbmQgc2h1dCBkb3duXG4gICAgdmFyIGVycm9yID0gbmV3IEVycm9yKCdTb2NrZXQgdGltZWQgb3V0IScpXG4gICAgdGhpcy5fb25FcnJvcihlcnJvcilcbiAgfVxuXG4gIC8qKlxuICAgKiBFbnN1cmVzIHRoYXQgdGhlIGNvbm5lY3Rpb24gaXMgY2xvc2VkIGFuZCBzdWNoXG4gICAqL1xuICBfZGVzdHJveSAoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcblxuICAgIGlmICghdGhpcy5kZXN0cm95ZWQpIHtcbiAgICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgICAgdGhpcy5vbmNsb3NlKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2VuZHMgYSBzdHJpbmcgdG8gdGhlIHNvY2tldC5cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAgICovXG4gIF9zZW5kU3RyaW5nIChjaHVuaykge1xuICAgIC8vIGVzY2FwZSBkb3RzXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuZGlzYWJsZUVzY2FwaW5nKSB7XG4gICAgICBjaHVuayA9IGNodW5rLnJlcGxhY2UoL1xcblxcLi9nLCAnXFxuLi4nKVxuICAgICAgaWYgKCh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXG4nIHx8ICF0aGlzLl9sYXN0RGF0YUJ5dGVzKSAmJiBjaHVuay5jaGFyQXQoMCkgPT09ICcuJykge1xuICAgICAgICBjaHVuayA9ICcuJyArIGNodW5rXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gS2VlcGluZyBleWUgb24gdGhlIGxhc3QgYnl0ZXMgc2VudCwgdG8gc2VlIGlmIHRoZXJlIGlzIGEgPENSPjxMRj4gc2VxdWVuY2VcbiAgICAvLyBhdCB0aGUgZW5kIHdoaWNoIGlzIG5lZWRlZCB0byBlbmQgdGhlIGRhdGEgc3RyZWFtXG4gICAgaWYgKGNodW5rLmxlbmd0aCA+IDIpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSBjaHVuay5zdWJzdHIoLTIpXG4gICAgfSBlbHNlIGlmIChjaHVuay5sZW5ndGggPT09IDEpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSB0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgKyBjaHVua1xuICAgIH1cblxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgJyArIGNodW5rLmxlbmd0aCArICcgYnl0ZXMgb2YgcGF5bG9hZCcpXG5cbiAgICAvLyBwYXNzIHRoZSBjaHVuayB0byB0aGUgc29ja2V0XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoY2h1bmspLmJ1ZmZlcilcbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGEgc3RyaW5nIGNvbW1hbmQgdG8gdGhlIHNlcnZlciwgYWxzbyBhcHBlbmQgXFxyXFxuIGlmIG5lZWRlZFxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIFN0cmluZyB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIF9zZW5kQ29tbWFuZCAoc3RyKSB7XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoc3RyICsgKHN0ci5zdWJzdHIoLTIpICE9PSAnXFxyXFxuJyA/ICdcXHJcXG4nIDogJycpKS5idWZmZXIpXG4gIH1cblxuICBfc2VuZCAoYnVmZmVyKSB7XG4gICAgdGhpcy5fc2V0VGltZW91dChidWZmZXIuYnl0ZUxlbmd0aClcbiAgICByZXR1cm4gdGhpcy5zb2NrZXQuc2VuZChidWZmZXIpXG4gIH1cblxuICBfc2V0VGltZW91dCAoYnl0ZUxlbmd0aCkge1xuICAgIHZhciBwcm9sb25nUGVyaW9kID0gTWF0aC5mbG9vcihieXRlTGVuZ3RoICogdGhpcy50aW1lb3V0U29ja2V0TXVsdGlwbGllcilcbiAgICB2YXIgdGltZW91dFxuXG4gICAgaWYgKHRoaXMuX2RhdGFNb2RlKSB7XG4gICAgICAvLyB3ZSdyZSBpbiBkYXRhIG1vZGUsIHNvIHdlIGNvdW50IG9ubHkgb25lIHRpbWVvdXQgdGhhdCBnZXQgZXh0ZW5kZWQgZm9yIGV2ZXJ5IHNlbmQoKS5cbiAgICAgIHZhciBub3cgPSBEYXRlLm5vdygpXG5cbiAgICAgIC8vIHRoZSBvbGQgdGltZW91dCBzdGFydCB0aW1lXG4gICAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgfHwgbm93XG5cbiAgICAgIC8vIHRoZSBvbGQgdGltZW91dCBwZXJpb2QsIG5vcm1hbGl6ZWQgdG8gYSBtaW5pbXVtIG9mIFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EXG4gICAgICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gKHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgfHwgdGhpcy50aW1lb3V0U29ja2V0TG93ZXJCb3VuZCkgKyBwcm9sb25nUGVyaW9kXG5cbiAgICAgIC8vIHRoZSBuZXcgdGltZW91dCBpcyB0aGUgZGVsdGEgYmV0d2VlbiB0aGUgbmV3IGZpcmluZyB0aW1lICg9IHRpbWVvdXQgcGVyaW9kICsgdGltZW91dCBzdGFydCB0aW1lKSBhbmQgbm93XG4gICAgICB0aW1lb3V0ID0gdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ICsgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCAtIG5vd1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBzZXQgbmV3IHRpbW91dFxuICAgICAgdGltZW91dCA9IHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQgKyBwcm9sb25nUGVyaW9kXG4gICAgfVxuXG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcikgLy8gY2xlYXIgcGVuZGluZyB0aW1lb3V0c1xuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lciA9IHNldFRpbWVvdXQodGhpcy5fb25UaW1lb3V0LmJpbmQodGhpcyksIHRpbWVvdXQpIC8vIGFybSB0aGUgbmV4dCB0aW1lb3V0XG4gIH1cblxuICAvKipcbiAgICogSW50aXRpYXRlIGF1dGhlbnRpY2F0aW9uIHNlcXVlbmNlIGlmIG5lZWRlZFxuICAgKi9cbiAgX2F1dGhlbnRpY2F0ZVVzZXIgKCkge1xuICAgIGlmICghdGhpcy5vcHRpb25zLmF1dGgpIHtcbiAgICAgIC8vIG5vIG5lZWQgdG8gYXV0aGVudGljYXRlLCBhdCBsZWFzdCBubyBkYXRhIGdpdmVuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmlkbGUoKSAvLyByZWFkeSB0byB0YWtlIG9yZGVyc1xuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdmFyIGF1dGhcblxuICAgIGlmICghdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgJiYgdGhpcy5vcHRpb25zLmF1dGgueG9hdXRoMikge1xuICAgICAgdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgPSAnWE9BVVRIMidcbiAgICB9XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmF1dGhNZXRob2QpIHtcbiAgICAgIGF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZC50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyB1c2UgZmlyc3Qgc3VwcG9ydGVkXG4gICAgICBhdXRoID0gKHRoaXMuX3N1cHBvcnRlZEF1dGhbMF0gfHwgJ1BMQUlOJykudG9VcHBlckNhc2UoKS50cmltKClcbiAgICB9XG5cbiAgICBzd2l0Y2ggKGF1dGgpIHtcbiAgICAgIGNhc2UgJ0xPR0lOJzpcbiAgICAgICAgLy8gTE9HSU4gaXMgYSAzIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgICAvLyBDOiBBVVRIIExPR0lOXG4gICAgICAgIC8vIEM6IEJBU0U2NChVU0VSKVxuICAgICAgICAvLyBDOiBCQVNFNjQoUEFTUylcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggTE9HSU4nKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9VU0VSXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIExPR0lOJylcbiAgICAgICAgcmV0dXJuXG4gICAgICBjYXNlICdQTEFJTic6XG4gICAgICAgIC8vIEFVVEggUExBSU4gaXMgYSAxIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgICAvLyBDOiBBVVRIIFBMQUlOIEJBU0U2NChcXDAgVVNFUiBcXDAgUEFTUylcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggUExBSU4nKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKFxuICAgICAgICAgIC8vIGNvbnZlcnQgdG8gQkFTRTY0XG4gICAgICAgICAgJ0FVVEggUExBSU4gJyArXG4gICAgICAgICAgZW5jb2RlKFxuICAgICAgICAgICAgLy8gdGhpcy5vcHRpb25zLmF1dGgudXNlcisnXFx1MDAwMCcrXG4gICAgICAgICAgICAnXFx1MDAwMCcgKyAvLyBza2lwIGF1dGhvcml6YXRpb24gaWRlbnRpdHkgYXMgaXQgY2F1c2VzIHByb2JsZW1zIHdpdGggc29tZSBzZXJ2ZXJzXG4gICAgICAgICAgICB0aGlzLm9wdGlvbnMuYXV0aC51c2VyICsgJ1xcdTAwMDAnICtcbiAgICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnBhc3MpXG4gICAgICAgIClcbiAgICAgICAgcmV0dXJuXG4gICAgICBjYXNlICdYT0FVVEgyJzpcbiAgICAgICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVycy5nb29nbGUuY29tL2dtYWlsL3hvYXV0aDJfcHJvdG9jb2wjc210cF9wcm90b2NvbF9leGNoYW5nZVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBYT0FVVEgyJylcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfWE9BVVRIMlxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnQVVUSCBYT0FVVEgyICcgKyB0aGlzLl9idWlsZFhPQXV0aDJUb2tlbih0aGlzLm9wdGlvbnMuYXV0aC51c2VyLCB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSlcbiAgICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ1Vua25vd24gYXV0aGVudGljYXRpb24gbWV0aG9kICcgKyBhdXRoKSlcbiAgfVxuXG4gIC8vIEFDVElPTlMgRk9SIFJFU1BPTlNFUyBGUk9NIFRIRSBTTVRQIFNFUlZFUlxuXG4gIC8qKlxuICAgKiBJbml0aWFsIHJlc3BvbnNlIGZyb20gdGhlIHNlcnZlciwgbXVzdCBoYXZlIGEgc3RhdHVzIDIyMFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uR3JlZXRpbmcgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAyMjApIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGdyZWV0aW5nOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkxITE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkVITE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gTEhMT1xuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uTEhMTyAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMSExPIG5vdCBzdWNjZXNzZnVsJylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIGFzIEVITE8gcmVzcG9uc2VcbiAgICB0aGlzLl9hY3Rpb25FSExPKGNvbW1hbmQpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gRUhMTy4gSWYgdGhlIHJlc3BvbnNlIGlzIGFuIGVycm9yLCB0cnkgSEVMTyBpbnN0ZWFkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25FSExPIChjb21tYW5kKSB7XG4gICAgdmFyIG1hdGNoXG5cbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlICYmIHRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICAgIHZhciBlcnJNc2cgPSAnU1RBUlRUTFMgbm90IHN1cHBvcnRlZCB3aXRob3V0IEVITE8nXG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXJyTXNnKVxuICAgICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihlcnJNc2cpKVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgLy8gVHJ5IEhFTE8gaW5zdGVhZFxuICAgICAgdGhpcy5sb2dnZXIud2FybmluZyhERUJVR19UQUcsICdFSExPIG5vdCBzdWNjZXNzZnVsLCB0cnlpbmcgSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSEVMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0hFTE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgUExBSU4gYXV0aFxuICAgIGlmIChjb21tYW5kLmRhdGEubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylQTEFJTi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggUExBSU4nKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdQTEFJTicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgTE9HSU4gYXV0aFxuICAgIGlmIChjb21tYW5kLmRhdGEubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylMT0dJTi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggTE9HSU4nKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdMT0dJTicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgWE9BVVRIMiBhdXRoXG4gICAgaWYgKGNvbW1hbmQuZGF0YS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVhPQVVUSDIvaSkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIFhPQVVUSDInKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdYT0FVVEgyJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgbWF4aW11bSBhbGxvd2VkIG1lc3NhZ2Ugc2l6ZVxuICAgIGlmICgobWF0Y2ggPSBjb21tYW5kLmRhdGEubWF0Y2goL1NJWkUgKFxcZCspL2kpKSAmJiBOdW1iZXIobWF0Y2hbMV0pKSB7XG4gICAgICBjb25zdCBtYXhBbGxvd2VkU2l6ZSA9IE51bWJlcihtYXRjaFsxXSlcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01heGltdW0gYWxsb3dkIG1lc3NhZ2Ugc2l6ZTogJyArIG1heEFsbG93ZWRTaXplKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFNUQVJUVExTXG4gICAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlKSB7XG4gICAgICBpZiAoKGNvbW1hbmQuZGF0YS5tYXRjaCgvU1RBUlRUTFNcXHM/JC9taSkgJiYgIXRoaXMub3B0aW9ucy5pZ25vcmVUTFMpIHx8ICEhdGhpcy5vcHRpb25zLnJlcXVpcmVUTFMpIHtcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblNUQVJUVExTXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgU1RBUlRUTFMnKVxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnU1RBUlRUTFMnKVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGVzIHNlcnZlciByZXNwb25zZSBmb3IgU1RBUlRUTFMgY29tbWFuZC4gSWYgdGhlcmUncyBhbiBlcnJvclxuICAgKiB0cnkgSEVMTyBpbnN0ZWFkLCBvdGhlcndpc2UgaW5pdGlhdGUgVExTIHVwZ3JhZGUuIElmIHRoZSB1cGdyYWRlXG4gICAqIHN1Y2NlZWRlcyByZXN0YXJ0IHRoZSBFSExPXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBzdHIgTWVzc2FnZSBmcm9tIHRoZSBzZXJ2ZXJcbiAgICovXG4gIF9hY3Rpb25TVEFSVFRMUyAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdTVEFSVFRMUyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fc2VjdXJlTW9kZSA9IHRydWVcbiAgICB0aGlzLnNvY2tldC51cGdyYWRlVG9TZWN1cmUoKVxuXG4gICAgLy8gcmVzdGFydCBwcm90b2NvbCBmbG93XG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkVITE9cbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gSEVMT1xuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uSEVMTyAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdIRUxPIG5vdCBzdWNjZXNzZnVsJylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBMT0dJTiwgaWYgc3VjY2Vzc2Z1bCBleHBlY3RzIGJhc2U2NCBlbmNvZGVkIHVzZXJuYW1lXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX0xPR0lOX1VTRVIgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAzMzQgfHwgY29tbWFuZC5kYXRhICE9PSAnVlhObGNtNWhiV1U2Jykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBVU0VSIG5vdCBzdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgbG9naW4gc2VxdWVuY2Ugd2hpbGUgd2FpdGluZyBmb3IgXCIzMzQgVlhObGNtNWhiV1U2IFwiOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBVVRIIExPR0lOIFVTRVIgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfTE9HSU5fUEFTU1xuICAgIHRoaXMuX3NlbmRDb21tYW5kKGVuY29kZSh0aGlzLm9wdGlvbnMuYXV0aC51c2VyKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIExPR0lOIHVzZXJuYW1lLCBpZiBzdWNjZXNzZnVsIGV4cGVjdHMgYmFzZTY0IGVuY29kZWQgcGFzc3dvcmRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDMzNCB8fCBjb21tYW5kLmRhdGEgIT09ICdVR0Z6YzNkdmNtUTYnKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdBVVRIIExPR0lOIFBBU1Mgbm90IHN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBsb2dpbiBzZXF1ZW5jZSB3aGlsZSB3YWl0aW5nIGZvciBcIjMzNCBVR0Z6YzNkdmNtUTYgXCI6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gUEFTUyBzdWNjZXNzZnVsJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoZW5jb2RlKHRoaXMub3B0aW9ucy5hdXRoLnBhc3MpKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggWE9BVVRIMiB0b2tlbiwgaWYgZXJyb3Igb2NjdXJzIHNlbmQgZW1wdHkgcmVzcG9uc2VcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhfWE9BVVRIMiAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci53YXJuaW5nKERFQlVHX1RBRywgJ0Vycm9yIGR1cmluZyBBVVRIIFhPQVVUSDIsIHNlbmRpbmcgZW1wdHkgcmVzcG9uc2UnKVxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJycpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZShjb21tYW5kKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBDaGVja3MgaWYgYXV0aGVudGljYXRpb24gc3VjY2VlZGVkIG9yIG5vdC4gSWYgc3VjY2Vzc2Z1bGx5IGF1dGhlbnRpY2F0ZWRcbiAgICogZW1pdCBgaWRsZWAgdG8gaW5kaWNhdGUgdGhhdCBhbiBlLW1haWwgY2FuIGJlIHNlbnQgdXNpbmcgdGhpcyBjb25uZWN0aW9uXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25BVVRIQ29tcGxldGUgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gZmFpbGVkOiAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHN1Y2Nlc3NmdWwuJylcblxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IHRoaXMub3B0aW9ucy5hdXRoLnVzZXJcblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgdGhpcy5vbmlkbGUoKSAvLyByZWFkeSB0byB0YWtlIG9yZGVyc1xuICB9XG5cbiAgLyoqXG4gICAqIFVzZWQgd2hlbiB0aGUgY29ubmVjdGlvbiBpcyBpZGxlIGFuZCB0aGUgc2VydmVyIGVtaXRzIHRpbWVvdXRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbklkbGUgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlID4gMzAwKSB7XG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBNQUlMIEZST00gY29tbWFuZC4gUHJvY2VlZCB0byBkZWZpbmluZyBSQ1BUIFRPIGxpc3QgaWYgc3VjY2Vzc2Z1bFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uTUFJTCAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNQUlMIEZST00gdW5zdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIGlmICghdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0NhblxcJ3Qgc2VuZCBtYWlsIC0gbm8gcmVjaXBpZW50cyBkZWZpbmVkJykpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01BSUwgRlJPTSBzdWNjZXNzZnVsLCBwcm9jZWVkaW5nIHdpdGggJyArIHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGggKyAnIHJlY2lwaWVudHMnKVxuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQWRkaW5nIHJlY2lwaWVudC4uLicpXG4gICAgICB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgPSB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUuc2hpZnQoKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblJDUFRcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdSQ1BUIFRPOjwnICsgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ICsgJz4nKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBhIFJDUFQgVE8gY29tbWFuZC4gSWYgdGhlIGNvbW1hbmQgaXMgdW5zdWNjZXNzZnVsLCB0cnkgdGhlIG5leHQgb25lLFxuICAgKiBhcyB0aGlzIG1pZ2h0IGJlIHJlbGF0ZWQgb25seSB0byB0aGUgY3VycmVudCByZWNpcGllbnQsIG5vdCBhIGdsb2JhbCBlcnJvciwgc29cbiAgICogdGhlIGZvbGxvd2luZyByZWNpcGllbnRzIG1pZ2h0IHN0aWxsIGJlIHZhbGlkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25SQ1BUIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLndhcm5pbmcoREVCVUdfVEFHLCAnUkNQVCBUTyBmYWlsZWQgZm9yOiAnICsgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgICAgLy8gdGhpcyBpcyBhIHNvZnQgZXJyb3JcbiAgICAgIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQucHVzaCh0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUucHVzaCh0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoKSB7XG4gICAgICBpZiAodGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5sZW5ndGggPCB0aGlzLl9lbnZlbG9wZS50by5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkRBVEFcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnUkNQVCBUTyBkb25lLCBwcm9jZWVkaW5nIHdpdGggcGF5bG9hZCcpXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdEQVRBJylcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdDYW5cXCd0IHNlbmQgbWFpbCAtIGFsbCByZWNpcGllbnRzIHdlcmUgcmVqZWN0ZWQnKSlcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQWRkaW5nIHJlY2lwaWVudC4uLicpXG4gICAgICB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgPSB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUuc2hpZnQoKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblJDUFRcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdSQ1BUIFRPOjwnICsgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ICsgJz4nKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byB0aGUgREFUQSBjb21tYW5kLiBTZXJ2ZXIgaXMgbm93IHdhaXRpbmcgZm9yIGEgbWVzc2FnZSwgc28gZW1pdCBgb25yZWFkeWBcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkRBVEEgKGNvbW1hbmQpIHtcbiAgICAvLyByZXNwb25zZSBzaG91bGQgYmUgMzU0IGJ1dCBhY2NvcmRpbmcgdG8gdGhpcyBpc3N1ZSBodHRwczovL2dpdGh1Yi5jb20vZWxlaXRoL2VtYWlsanMvaXNzdWVzLzI0XG4gICAgLy8gc29tZSBzZXJ2ZXJzIG1pZ2h0IHVzZSAyNTAgaW5zdGVhZFxuICAgIGlmIChbMjUwLCAzNTRdLmluZGV4T2YoY29tbWFuZC5zdGF0dXNDb2RlKSA8IDApIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0RBVEEgdW5zdWNjZXNzZnVsICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fZGF0YU1vZGUgPSB0cnVlXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9ucmVhZHkodGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSBmcm9tIHRoZSBzZXJ2ZXIsIG9uY2UgdGhlIG1lc3NhZ2Ugc3RyZWFtIGhhcyBlbmRlZCB3aXRoIDxDUj48TEY+LjxDUj48TEY+XG4gICAqIEVtaXRzIGBvbmRvbmVgLlxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uU3RyZWFtIChjb21tYW5kKSB7XG4gICAgdmFyIHJjcHRcblxuICAgIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgICAgLy8gTE1UUCByZXR1cm5zIGEgcmVzcG9uc2UgY29kZSBmb3IgKmV2ZXJ5KiBzdWNjZXNzZnVsbHkgc2V0IHJlY2lwaWVudFxuICAgICAgLy8gRm9yIGV2ZXJ5IHJlY2lwaWVudCB0aGUgbWVzc2FnZSBtaWdodCBzdWNjZWVkIG9yIGZhaWwgaW5kaXZpZHVhbGx5XG5cbiAgICAgIHJjcHQgPSB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnNoaWZ0KClcbiAgICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xvY2FsIGRlbGl2ZXJ5IHRvICcgKyByY3B0ICsgJyBmYWlsZWQuJylcbiAgICAgICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHJjcHQpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgc3VjY2VlZGVkLicpXG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLmxlbmd0aCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmRvbmUodHJ1ZSlcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRm9yIFNNVFAgdGhlIG1lc3NhZ2UgZWl0aGVyIGZhaWxzIG9yIHN1Y2NlZWRzLCB0aGVyZSBpcyBubyBpbmZvcm1hdGlvblxuICAgICAgLy8gYWJvdXQgaW5kaXZpZHVhbCByZWNpcGllbnRzXG5cbiAgICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VuZGluZyBmYWlsZWQuJylcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VudCBzdWNjZXNzZnVsbHkuJylcbiAgICAgIH1cblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25kb25lKCEhY29tbWFuZC5zdWNjZXNzKVxuICAgIH1cblxuICAgIC8vIElmIHRoZSBjbGllbnQgd2FudGVkIHRvIGRvIHNvbWV0aGluZyBlbHNlIChlZy4gdG8gcXVpdCksIGRvIG5vdCBmb3JjZSBpZGxlXG4gICAgaWYgKHRoaXMuX2N1cnJlbnRBY3Rpb24gPT09IHRoaXMuX2FjdGlvbklkbGUpIHtcbiAgICAgIC8vIFdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9uc1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnSWRsaW5nIHdoaWxlIHdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9ucy4uLicpXG4gICAgICB0aGlzLm9uaWRsZSgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEJ1aWxkcyBhIGxvZ2luIHRva2VuIGZvciBYT0FVVEgyIGF1dGhlbnRpY2F0aW9uIGNvbW1hbmRcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHVzZXIgRS1tYWlsIGFkZHJlc3Mgb2YgdGhlIHVzZXJcbiAgICogQHBhcmFtIHtTdHJpbmd9IHRva2VuIFZhbGlkIGFjY2VzcyB0b2tlbiBmb3IgdGhlIHVzZXJcbiAgICogQHJldHVybiB7U3RyaW5nfSBCYXNlNjQgZm9ybWF0dGVkIGxvZ2luIHRva2VuXG4gICAqL1xuICBfYnVpbGRYT0F1dGgyVG9rZW4gKHVzZXIsIHRva2VuKSB7XG4gICAgdmFyIGF1dGhEYXRhID0gW1xuICAgICAgJ3VzZXI9JyArICh1c2VyIHx8ICcnKSxcbiAgICAgICdhdXRoPUJlYXJlciAnICsgdG9rZW4sXG4gICAgICAnJyxcbiAgICAgICcnXG4gICAgXVxuICAgIC8vIGJhc2U2NChcInVzZXI9e1VzZXJ9XFx4MDBhdXRoPUJlYXJlciB7VG9rZW59XFx4MDBcXHgwMFwiKVxuICAgIHJldHVybiBlbmNvZGUoYXV0aERhdGEuam9pbignXFx4MDEnKSlcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBTbXRwQ2xpZW50XG4iXX0=