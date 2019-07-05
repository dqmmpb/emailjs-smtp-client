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
      console.log('_sendCommand', str);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9hdXRoZW50aWNhdGVkQXMiLCJfc3VwcG9ydGVkQXV0aCIsIl9kYXRhTW9kZSIsIl9sYXN0RGF0YUJ5dGVzIiwiX2VudmVsb3BlIiwiX2N1cnJlbnRBY3Rpb24iLCJfc2VjdXJlTW9kZSIsIl9zb2NrZXRUaW1lb3V0VGltZXIiLCJfc29ja2V0VGltZW91dFN0YXJ0IiwiX3NvY2tldFRpbWVvdXRQZXJpb2QiLCJfcGFyc2VCbG9jayIsImRhdGEiLCJzdGF0dXNDb2RlIiwiX3BhcnNlUmVtYWluZGVyIiwiZHVtbXlMb2dnZXIiLCJyZWR1Y2UiLCJvIiwibCIsImxvZ2dlciIsIm9uZXJyb3IiLCJlIiwib25kcmFpbiIsIm9uY2xvc2UiLCJvbmlkbGUiLCJvbnJlYWR5IiwiZmFpbGVkUmVjaXBpZW50cyIsIm9uZG9uZSIsInN1Y2Nlc3MiLCJTb2NrZXRDb250cnVjdG9yIiwiVENQU29ja2V0Iiwib3BlbiIsImJpbmFyeVR5cGUiLCJjYSIsInRsc1dvcmtlclBhdGgiLCJ3cyIsIm9uY2VydCIsImNlcnQiLCJFIiwiX29uRXJyb3IiLCJiaW5kIiwib25vcGVuIiwiX29uT3BlbiIsImRlYnVnIiwiX3NlbmRDb21tYW5kIiwiY2xvc2UiLCJyZWFkeVN0YXRlIiwiX2Rlc3Ryb3kiLCJlbnZlbG9wZSIsImZyb20iLCJjb25jYXQiLCJ0byIsInJjcHRRdWV1ZSIsInJjcHRGYWlsZWQiLCJyZXNwb25zZVF1ZXVlIiwiX2FjdGlvbk1BSUwiLCJjaHVuayIsIl9zZW5kU3RyaW5nIiwibGVuZ3RoIiwic2VuZCIsIl9hY3Rpb25TdHJlYW0iLCJfc2VuZCIsIlVpbnQ4QXJyYXkiLCJidWZmZXIiLCJzdWJzdHIiLCJsaW5lcyIsInNwbGl0IiwicG9wIiwiaSIsImxlbiIsInRyaW0iLCJtYXRjaCIsInB1c2giLCJOdW1iZXIiLCJyZXNwb25zZSIsImpvaW4iLCJfb25Db21tYW5kIiwiZXZlbnQiLCJwcm94eUhvc3RuYW1lIiwib25kYXRhIiwiX29uRGF0YSIsIl9vbkNsb3NlIiwiX29uRHJhaW4iLCJfYWN0aW9uR3JlZXRpbmciLCJldnQiLCJjbGVhclRpbWVvdXQiLCJzdHJpbmdQYXlsb2FkIiwiVGV4dERlY29kZXIiLCJkZWNvZGUiLCJfcGFyc2UiLCJFcnJvciIsIm1lc3NhZ2UiLCJlcnJvciIsImNvbW1hbmQiLCJkaXNhYmxlRXNjYXBpbmciLCJyZXBsYWNlIiwiY2hhckF0IiwiVGV4dEVuY29kZXIiLCJlbmNvZGUiLCJzdHIiLCJjb25zb2xlIiwibG9nIiwiX3NldFRpbWVvdXQiLCJieXRlTGVuZ3RoIiwicHJvbG9uZ1BlcmlvZCIsIk1hdGgiLCJmbG9vciIsInRpbWVvdXQiLCJub3ciLCJEYXRlIiwic2V0VGltZW91dCIsIl9vblRpbWVvdXQiLCJfYWN0aW9uSWRsZSIsImF1dGhNZXRob2QiLCJ4b2F1dGgyIiwidG9VcHBlckNhc2UiLCJfYWN0aW9uQVVUSF9MT0dJTl9VU0VSIiwiX2FjdGlvbkFVVEhDb21wbGV0ZSIsInVzZXIiLCJwYXNzIiwiX2FjdGlvbkFVVEhfWE9BVVRIMiIsIl9idWlsZFhPQXV0aDJUb2tlbiIsImxtdHAiLCJfYWN0aW9uTEhMTyIsIl9hY3Rpb25FSExPIiwicmVxdWlyZVRMUyIsImVyck1zZyIsIndhcm5pbmciLCJfYWN0aW9uSEVMTyIsIm1heEFsbG93ZWRTaXplIiwiaWdub3JlVExTIiwiX2FjdGlvblNUQVJUVExTIiwiX2F1dGhlbnRpY2F0ZVVzZXIiLCJ1cGdyYWRlVG9TZWN1cmUiLCJfYWN0aW9uQVVUSF9MT0dJTl9QQVNTIiwiY3VyUmVjaXBpZW50Iiwic2hpZnQiLCJfYWN0aW9uUkNQVCIsIl9hY3Rpb25EQVRBIiwiaW5kZXhPZiIsInJjcHQiLCJ0b2tlbiIsImF1dGhEYXRhIl0sIm1hcHBpbmdzIjoiOzs7Ozs7cWpCQUFBOztBQUVBOztBQUNBOzs7O0FBQ0E7Ozs7OztBQUVBLElBQUlBLFlBQVksYUFBaEI7O0FBRUE7OztBQUdBLElBQU1DLDZCQUE2QixLQUFuQzs7QUFFQTs7Ozs7OztBQU9BLElBQU1DLDRCQUE0QixHQUFsQzs7SUFFTUMsVTtBQUNKOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBbUJBLHNCQUFhQyxJQUFiLEVBQW1CQyxJQUFuQixFQUF1QztBQUFBLFFBQWRDLE9BQWMsdUVBQUosRUFBSTs7QUFBQTs7QUFDckMsU0FBS0EsT0FBTCxHQUFlQSxPQUFmOztBQUVBLFNBQUtDLHVCQUFMLEdBQStCTiwwQkFBL0I7QUFDQSxTQUFLTyx1QkFBTCxHQUErQk4seUJBQS9COztBQUVBLFNBQUtHLElBQUwsR0FBWUEsU0FBUyxLQUFLQyxPQUFMLENBQWFHLGtCQUFiLEdBQWtDLEdBQWxDLEdBQXdDLEVBQWpELENBQVo7QUFDQSxTQUFLTCxJQUFMLEdBQVlBLFFBQVEsV0FBcEI7O0FBRUE7Ozs7O0FBS0EsU0FBS0UsT0FBTCxDQUFhRyxrQkFBYixHQUFrQyx3QkFBd0IsS0FBS0gsT0FBN0IsR0FBdUMsQ0FBQyxDQUFDLEtBQUtBLE9BQUwsQ0FBYUcsa0JBQXRELEdBQTJFLEtBQUtKLElBQUwsS0FBYyxHQUEzSDs7QUFFQSxTQUFLQyxPQUFMLENBQWFJLElBQWIsR0FBb0IsS0FBS0osT0FBTCxDQUFhSSxJQUFiLElBQXFCLEtBQXpDLENBaEJxQyxDQWdCVTtBQUMvQyxTQUFLSixPQUFMLENBQWFLLElBQWIsR0FBb0IsS0FBS0wsT0FBTCxDQUFhSyxJQUFiLElBQXFCLFdBQXpDLENBakJxQyxDQWlCZ0I7QUFDckQsU0FBS0MsTUFBTCxHQUFjLEtBQWQsQ0FsQnFDLENBa0JqQjtBQUNwQixT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QUt0RCxjQUFMLEdBQXNCLEtBQUswRyxXQUEzQjtBQUNBLGFBQUtyRixNQUFMLENBQVksSUFBWjtBQUNELE9BbkJELE1BbUJPO0FBQ0w7QUFDQTs7QUFFQSxZQUFJLENBQUNrRSxRQUFRakUsT0FBYixFQUFzQjtBQUNwQixlQUFLVCxNQUFMLENBQVl5RSxLQUFaLENBQWtCMUcsU0FBbEIsRUFBNkIseUJBQTdCO0FBQ0QsU0FGRCxNQUVPO0FBQ0wsZUFBS2lDLE1BQUwsQ0FBWXdCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2Qiw0QkFBN0I7QUFDRDs7QUFFRCxhQUFLb0IsY0FBTCxHQUFzQixLQUFLMEcsV0FBM0I7QUFDQSxhQUFLckYsTUFBTCxDQUFZLENBQUMsQ0FBQ2tFLFFBQVFqRSxPQUF0QjtBQUNEOztBQUVEO0FBQ0EsVUFBSSxLQUFLdEIsY0FBTCxLQUF3QixLQUFLMEcsV0FBakMsRUFBOEM7QUFDNUM7QUFDQSxhQUFLN0YsTUFBTCxDQUFZd0IsS0FBWixDQUFrQnpELFNBQWxCLEVBQTZCLDZDQUE3QjtBQUNBLGFBQUtzQyxNQUFMO0FBQ0Q7QUFDRjs7QUFFRDs7Ozs7Ozs7Ozt1Q0FPb0I4RixJLEVBQU11QixLLEVBQU87QUFDL0IsVUFBSUMsV0FBVyxDQUNiLFdBQVd4QixRQUFRLEVBQW5CLENBRGEsRUFFYixpQkFBaUJ1QixLQUZKLEVBR2IsRUFIYSxFQUliLEVBSmEsQ0FBZjtBQU1BO0FBQ0EsYUFBTyx5QkFBT0MsU0FBU25FLElBQVQsQ0FBYyxNQUFkLENBQVAsQ0FBUDtBQUNEOzs7Ozs7a0JBR1l0RixVIiwiZmlsZSI6ImNsaWVudC5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qIGVzbGludC1kaXNhYmxlIGNhbWVsY2FzZSAqL1xuXG5pbXBvcnQgeyBlbmNvZGUgfSBmcm9tICdlbWFpbGpzLWJhc2U2NCdcbmltcG9ydCBUQ1BTb2NrZXQgZnJvbSAnZW1haWxqcy10Y3Atc29ja2V0J1xuaW1wb3J0IHsgVGV4dERlY29kZXIsIFRleHRFbmNvZGVyIH0gZnJvbSAndGV4dC1lbmNvZGluZydcblxudmFyIERFQlVHX1RBRyA9ICdTTVRQIENsaWVudCdcblxuLyoqXG4gKiBMb3dlciBCb3VuZCBmb3Igc29ja2V0IHRpbWVvdXQgdG8gd2FpdCBzaW5jZSB0aGUgbGFzdCBkYXRhIHdhcyB3cml0dGVuIHRvIGEgc29ja2V0XG4gKi9cbmNvbnN0IFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EID0gMTAwMDBcblxuLyoqXG4gKiBNdWx0aXBsaWVyIGZvciBzb2NrZXQgdGltZW91dDpcbiAqXG4gKiBXZSBhc3N1bWUgYXQgbGVhc3QgYSBHUFJTIGNvbm5lY3Rpb24gd2l0aCAxMTUga2IvcyA9IDE0LDM3NSBrQi9zIHRvcHMsIHNvIDEwIEtCL3MgdG8gYmUgb25cbiAqIHRoZSBzYWZlIHNpZGUuIFdlIGNhbiB0aW1lb3V0IGFmdGVyIGEgbG93ZXIgYm91bmQgb2YgMTBzICsgKG4gS0IgLyAxMCBLQi9zKS4gQSAxIE1CIG1lc3NhZ2VcbiAqIHVwbG9hZCB3b3VsZCBiZSAxMTAgc2Vjb25kcyB0byB3YWl0IGZvciB0aGUgdGltZW91dC4gMTAgS0IvcyA9PT0gMC4xIHMvQlxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSID0gMC4xXG5cbmNsYXNzIFNtdHBDbGllbnQge1xuICAvKipcbiAgICogQ3JlYXRlcyBhIGNvbm5lY3Rpb24gb2JqZWN0IHRvIGEgU01UUCBzZXJ2ZXIgYW5kIGFsbG93cyB0byBzZW5kIG1haWwgdGhyb3VnaCBpdC5cbiAgICogQ2FsbCBgY29ubmVjdGAgbWV0aG9kIHRvIGluaXRpdGF0ZSB0aGUgYWN0dWFsIGNvbm5lY3Rpb24sIHRoZSBjb25zdHJ1Y3RvciBvbmx5XG4gICAqIGRlZmluZXMgdGhlIHByb3BlcnRpZXMgYnV0IGRvZXMgbm90IGFjdHVhbGx5IGNvbm5lY3QuXG4gICAqXG4gICAqIE5CISBUaGUgcGFyYW1ldGVyIG9yZGVyIChob3N0LCBwb3J0KSBkaWZmZXJzIGZyb20gbm9kZS5qcyBcIndheVwiIChwb3J0LCBob3N0KVxuICAgKlxuICAgKiBAY29uc3RydWN0b3JcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IFtob3N0PVwibG9jYWxob3N0XCJdIEhvc3RuYW1lIHRvIGNvbmVuY3QgdG9cbiAgICogQHBhcmFtIHtOdW1iZXJ9IFtwb3J0PTI1XSBQb3J0IG51bWJlciB0byBjb25uZWN0IHRvXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gT3B0aW9uYWwgb3B0aW9ucyBvYmplY3RcbiAgICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnRdIFNldCB0byB0cnVlLCB0byB1c2UgZW5jcnlwdGVkIGNvbm5lY3Rpb25cbiAgICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLm5hbWVdIENsaWVudCBob3N0bmFtZSBmb3IgaW50cm9kdWNpbmcgaXRzZWxmIHRvIHRoZSBzZXJ2ZXJcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zLmF1dGhdIEF1dGhlbnRpY2F0aW9uIG9wdGlvbnMuIERlcGVuZHMgb24gdGhlIHByZWZlcnJlZCBhdXRoZW50aWNhdGlvbiBtZXRob2QuIFVzdWFsbHkge3VzZXIsIHBhc3N9XG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5hdXRoTWV0aG9kXSBGb3JjZSBzcGVjaWZpYyBhdXRoZW50aWNhdGlvbiBtZXRob2RcbiAgICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy5kaXNhYmxlRXNjYXBpbmddIElmIHNldCB0byB0cnVlLCBkbyBub3QgZXNjYXBlIGRvdHMgb24gdGhlIGJlZ2lubmluZyBvZiB0aGUgbGluZXNcbiAgICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy5sb2dnZXJdIEEgd2luc3Rvbi1jb21wYXRpYmxlIGxvZ2dlclxuICAgKi9cbiAgY29uc3RydWN0b3IgKGhvc3QsIHBvcnQsIG9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnNcblxuICAgIHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQgPSBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORFxuICAgIHRoaXMudGltZW91dFNvY2tldE11bHRpcGxpZXIgPSBUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSXG5cbiAgICB0aGlzLnBvcnQgPSBwb3J0IHx8ICh0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0ID8gNDY1IDogMjUpXG4gICAgdGhpcy5ob3N0ID0gaG9zdCB8fCAnbG9jYWxob3N0J1xuXG4gICAgLyoqXG4gICAgICogSWYgc2V0IHRvIHRydWUsIHN0YXJ0IGFuIGVuY3J5cHRlZCBjb25uZWN0aW9uIGluc3RlYWQgb2YgdGhlIHBsYWludGV4dCBvbmVcbiAgICAgKiAocmVjb21tZW5kZWQgaWYgYXBwbGljYWJsZSkuIElmIHVzZVNlY3VyZVRyYW5zcG9ydCBpcyBub3Qgc2V0IGJ1dCB0aGUgcG9ydCB1c2VkIGlzIDQ2NSxcbiAgICAgKiB0aGVuIGVjcnlwdGlvbiBpcyB1c2VkIGJ5IGRlZmF1bHQuXG4gICAgICovXG4gICAgdGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA9ICd1c2VTZWN1cmVUcmFuc3BvcnQnIGluIHRoaXMub3B0aW9ucyA/ICEhdGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA6IHRoaXMucG9ydCA9PT0gNDY1XG5cbiAgICB0aGlzLm9wdGlvbnMuYXV0aCA9IHRoaXMub3B0aW9ucy5hdXRoIHx8IGZhbHNlIC8vIEF1dGhlbnRpY2F0aW9uIG9iamVjdC4gSWYgbm90IHNldCwgYXV0aGVudGljYXRpb24gc3RlcCB3aWxsIGJlIHNraXBwZWQuXG4gICAgdGhpcy5vcHRpb25zLm5hbWUgPSB0aGlzLm9wdGlvbnMubmFtZSB8fCAnbG9jYWxob3N0JyAvLyBIb3N0bmFtZSBvZiB0aGUgY2xpZW50LCB0aGlzIHdpbGwgYmUgdXNlZCBmb3IgaW50cm9kdWNpbmcgdG8gdGhlIHNlcnZlclxuICAgIHRoaXMuc29ja2V0ID0gZmFsc2UgLy8gRG93bnN0cmVhbSBUQ1Agc29ja2V0IHRvIHRoZSBTTVRQIHNlcnZlciwgY3JlYXRlZCB3aXRoIG1velRDUFNvY2tldFxuICAgIHRoaXMuZGVzdHJveWVkID0gZmFsc2UgLy8gSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGhhcyBiZWVuIGNsb3NlZCBhbmQgY2FuJ3QgYmUgdXNlZCBhbnltb3JlXG4gICAgdGhpcy53YWl0RHJhaW4gPSBmYWxzZSAvLyBLZWVwcyB0cmFjayBpZiB0aGUgZG93bnN0cmVhbSBzb2NrZXQgaXMgY3VycmVudGx5IGZ1bGwgYW5kIGEgZHJhaW4gZXZlbnQgc2hvdWxkIGJlIHdhaXRlZCBmb3Igb3Igbm90XG5cbiAgICAvLyBQcml2YXRlIHByb3BlcnRpZXNcblxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IG51bGwgLy8gSWYgYXV0aGVudGljYXRlZCBzdWNjZXNzZnVsbHksIHN0b3JlcyB0aGUgdXNlcm5hbWVcbiAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoID0gW10gLy8gQSBsaXN0IG9mIGF1dGhlbnRpY2F0aW9uIG1lY2hhbmlzbXMgZGV0ZWN0ZWQgZnJvbSB0aGUgRUhMTyByZXNwb25zZSBhbmQgd2hpY2ggYXJlIGNvbXBhdGlibGUgd2l0aCB0aGlzIGxpYnJhcnlcbiAgICB0aGlzLl9kYXRhTW9kZSA9IGZhbHNlIC8vIElmIHRydWUsIGFjY2VwdHMgZGF0YSBmcm9tIHRoZSB1cHN0cmVhbSB0byBiZSBwYXNzZWQgZGlyZWN0bHkgdG8gdGhlIGRvd25zdHJlYW0gc29ja2V0LiBVc2VkIGFmdGVyIHRoZSBEQVRBIGNvbW1hbmRcbiAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gJycgLy8gS2VlcCB0cmFjayBvZiB0aGUgbGFzdCBieXRlcyB0byBzZWUgaG93IHRoZSB0ZXJtaW5hdGluZyBkb3Qgc2hvdWxkIGJlIHBsYWNlZFxuICAgIHRoaXMuX2VudmVsb3BlID0gbnVsbCAvLyBFbnZlbG9wZSBvYmplY3QgZm9yIHRyYWNraW5nIHdobyBpcyBzZW5kaW5nIG1haWwgdG8gd2hvbVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSBudWxsIC8vIFN0b3JlcyB0aGUgZnVuY3Rpb24gdGhhdCBzaG91bGQgYmUgcnVuIGFmdGVyIGEgcmVzcG9uc2UgaGFzIGJlZW4gcmVjZWl2ZWQgZnJvbSB0aGUgc2VydmVyXG4gICAgdGhpcy5fc2VjdXJlTW9kZSA9ICEhdGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCAvLyBJbmRpY2F0ZXMgaWYgdGhlIGNvbm5lY3Rpb24gaXMgc2VjdXJlZCBvciBwbGFpbnRleHRcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIgPSBmYWxzZSAvLyBUaW1lciB3YWl0aW5nIHRvIGRlY2xhcmUgdGhlIHNvY2tldCBkZWFkIHN0YXJ0aW5nIGZyb20gdGhlIGxhc3Qgd3JpdGVcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZSAvLyBTdGFydCB0aW1lIG9mIHNlbmRpbmcgdGhlIGZpcnN0IHBhY2tldCBpbiBkYXRhIG1vZGVcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gZmFsc2UgLy8gVGltZW91dCBmb3Igc2VuZGluZyBpbiBkYXRhIG1vZGUsIGdldHMgZXh0ZW5kZWQgd2l0aCBldmVyeSBzZW5kKClcblxuICAgIHRoaXMuX3BhcnNlQmxvY2sgPSB7IGRhdGE6IFtdLCBzdGF0dXNDb2RlOiBudWxsIH1cbiAgICB0aGlzLl9wYXJzZVJlbWFpbmRlciA9ICcnIC8vIElmIHRoZSBjb21wbGV0ZSBsaW5lIGlzIG5vdCByZWNlaXZlZCB5ZXQsIGNvbnRhaW5zIHRoZSBiZWdpbm5pbmcgb2YgaXRcblxuICAgIGNvbnN0IGR1bW15TG9nZ2VyID0gWydlcnJvcicsICd3YXJuaW5nJywgJ2luZm8nLCAnZGVidWcnXS5yZWR1Y2UoKG8sIGwpID0+IHsgb1tsXSA9ICgpID0+IHt9OyByZXR1cm4gbyB9LCB7fSlcbiAgICB0aGlzLmxvZ2dlciA9IG9wdGlvbnMubG9nZ2VyIHx8IGR1bW15TG9nZ2VyXG5cbiAgICAvLyBFdmVudCBwbGFjZWhvbGRlcnNcbiAgICB0aGlzLm9uZXJyb3IgPSAoZSkgPT4geyB9IC8vIFdpbGwgYmUgcnVuIHdoZW4gYW4gZXJyb3Igb2NjdXJzLiBUaGUgYG9uY2xvc2VgIGV2ZW50IHdpbGwgZmlyZSBzdWJzZXF1ZW50bHkuXG4gICAgdGhpcy5vbmRyYWluID0gKCkgPT4geyB9IC8vIE1vcmUgZGF0YSBjYW4gYmUgYnVmZmVyZWQgaW4gdGhlIHNvY2tldC5cbiAgICB0aGlzLm9uY2xvc2UgPSAoKSA9PiB7IH0gLy8gVGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciBoYXMgYmVlbiBjbG9zZWRcbiAgICB0aGlzLm9uaWRsZSA9ICgpID0+IHsgfSAvLyBUaGUgY29ubmVjdGlvbiBpcyBlc3RhYmxpc2hlZCBhbmQgaWRsZSwgeW91IGNhbiBzZW5kIG1haWwgbm93XG4gICAgdGhpcy5vbnJlYWR5ID0gKGZhaWxlZFJlY2lwaWVudHMpID0+IHsgfSAvLyBXYWl0aW5nIGZvciBtYWlsIGJvZHksIGxpc3RzIGFkZHJlc3NlcyB0aGF0IHdlcmUgbm90IGFjY2VwdGVkIGFzIHJlY2lwaWVudHNcbiAgICB0aGlzLm9uZG9uZSA9IChzdWNjZXNzKSA9PiB7IH0gLy8gVGhlIG1haWwgaGFzIGJlZW4gc2VudC4gV2FpdCBmb3IgYG9uaWRsZWAgbmV4dC4gSW5kaWNhdGVzIGlmIHRoZSBtZXNzYWdlIHdhcyBxdWV1ZWQgYnkgdGhlIHNlcnZlci5cbiAgfVxuXG4gIC8qKlxuICAgKiBJbml0aWF0ZSBhIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgY29ubmVjdCAoU29ja2V0Q29udHJ1Y3RvciA9IFRDUFNvY2tldCkge1xuICAgIHRoaXMuc29ja2V0ID0gU29ja2V0Q29udHJ1Y3Rvci5vcGVuKHRoaXMuaG9zdCwgdGhpcy5wb3J0LCB7XG4gICAgICBiaW5hcnlUeXBlOiAnYXJyYXlidWZmZXInLFxuICAgICAgdXNlU2VjdXJlVHJhbnNwb3J0OiB0aGlzLl9zZWN1cmVNb2RlLFxuICAgICAgY2E6IHRoaXMub3B0aW9ucy5jYSxcbiAgICAgIHRsc1dvcmtlclBhdGg6IHRoaXMub3B0aW9ucy50bHNXb3JrZXJQYXRoLFxuICAgICAgd3M6IHRoaXMub3B0aW9ucy53c1xuICAgIH0pXG5cbiAgICAvLyBhbGxvd3MgY2VydGlmaWNhdGUgaGFuZGxpbmcgZm9yIHBsYXRmb3JtIHcvbyBuYXRpdmUgdGxzIHN1cHBvcnRcbiAgICAvLyBvbmNlcnQgaXMgbm9uIHN0YW5kYXJkIHNvIHNldHRpbmcgaXQgbWlnaHQgdGhyb3cgaWYgdGhlIHNvY2tldCBvYmplY3QgaXMgaW1tdXRhYmxlXG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuc29ja2V0Lm9uY2VydCA9IChjZXJ0KSA9PiB7IHRoaXMub25jZXJ0ICYmIHRoaXMub25jZXJ0KGNlcnQpIH1cbiAgICB9IGNhdGNoIChFKSB7IH1cbiAgICB0aGlzLnNvY2tldC5vbmVycm9yID0gdGhpcy5fb25FcnJvci5iaW5kKHRoaXMpXG4gICAgdGhpcy5zb2NrZXQub25vcGVuID0gdGhpcy5fb25PcGVuLmJpbmQodGhpcylcbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kcyBRVUlUXG4gICAqL1xuICBxdWl0ICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFFVSVQuLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdRVUlUJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5jbG9zZVxuICB9XG5cbiAgLyoqXG4gICAqIENsb3NlcyB0aGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyXG4gICAqL1xuICBjbG9zZSAoKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQ2xvc2luZyBjb25uZWN0aW9uLi4uJylcbiAgICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICB0aGlzLnNvY2tldC5jbG9zZSgpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rlc3Ryb3koKVxuICAgIH1cbiAgfVxuXG4gIC8vIE1haWwgcmVsYXRlZCBtZXRob2RzXG5cbiAgLyoqXG4gICAqIEluaXRpYXRlcyBhIG5ldyBtZXNzYWdlIGJ5IHN1Ym1pdHRpbmcgZW52ZWxvcGUgZGF0YSwgc3RhcnRpbmcgd2l0aFxuICAgKiBgTUFJTCBGUk9NOmAgY29tbWFuZC4gVXNlIGFmdGVyIGBvbmlkbGVgIGV2ZW50XG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBlbnZlbG9wZSBFbnZlbG9wZSBvYmplY3QgaW4gdGhlIGZvcm0gb2Yge2Zyb206XCIuLi5cIiwgdG86W1wiLi4uXCJdfVxuICAgKi9cbiAgdXNlRW52ZWxvcGUgKGVudmVsb3BlKSB7XG4gICAgdGhpcy5fZW52ZWxvcGUgPSBlbnZlbG9wZSB8fCB7fVxuICAgIHRoaXMuX2VudmVsb3BlLmZyb20gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUuZnJvbSB8fCAoJ2Fub255bW91c0AnICsgdGhpcy5vcHRpb25zLm5hbWUpKVswXVxuICAgIHRoaXMuX2VudmVsb3BlLnRvID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLnRvIHx8IFtdKVxuXG4gICAgLy8gY2xvbmUgdGhlIHJlY2lwaWVudHMgYXJyYXkgZm9yIGxhdHRlciBtYW5pcHVsYXRpb25cbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUgPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8pXG4gICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZCA9IFtdXG4gICAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZSA9IFtdXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTUFJTFxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgTUFJTCBGUk9NLi4uJylcbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnTUFJTCBGUk9NOjwnICsgKHRoaXMuX2VudmVsb3BlLmZyb20pICsgJz4nKVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgQVNDSUkgZGF0YSB0byB0aGUgc2VydmVyLiBXb3JrcyBvbmx5IGluIGRhdGEgbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZFxuICAgKiBvdGhlcndpc2VcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAgICovXG4gIHNlbmQgKGNodW5rKSB7XG4gICAgLy8gd29ya3Mgb25seSBpbiBkYXRhIG1vZGVcbiAgICBpZiAoIXRoaXMuX2RhdGFNb2RlKSB7XG4gICAgICAvLyB0aGlzIGxpbmUgc2hvdWxkIG5ldmVyIGJlIHJlYWNoZWQgYnV0IGlmIGl0IGRvZXMsXG4gICAgICAvLyBhY3QgbGlrZSBldmVyeXRoaW5nJ3Mgbm9ybWFsLlxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9XG5cbiAgICAvLyBUT0RPOiBpZiB0aGUgY2h1bmsgaXMgYW4gYXJyYXlidWZmZXIsIHVzZSBhIHNlcGFyYXRlIGZ1bmN0aW9uIHRvIHNlbmQgdGhlIGRhdGFcbiAgICByZXR1cm4gdGhpcy5fc2VuZFN0cmluZyhjaHVuaylcbiAgfVxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZXMgdGhhdCBhIGRhdGEgc3RyZWFtIGZvciB0aGUgc29ja2V0IGlzIGVuZGVkLiBXb3JrcyBvbmx5IGluIGRhdGFcbiAgICogbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZCBvdGhlcndpc2UuIFVzZSBpdCB3aGVuIHlvdSBhcmUgZG9uZVxuICAgKiB3aXRoIHNlbmRpbmcgdGhlIG1haWwuIFRoaXMgbWV0aG9kIGRvZXMgbm90IGNsb3NlIHRoZSBzb2NrZXQuIE9uY2UgdGhlIG1haWxcbiAgICogaGFzIGJlZW4gcXVldWVkIGJ5IHRoZSBzZXJ2ZXIsIGBvbmRvbmVgIGFuZCBgb25pZGxlYCBhcmUgZW1pdHRlZC5cbiAgICpcbiAgICogQHBhcmFtIHtCdWZmZXJ9IFtjaHVua10gQ2h1bmsgb2YgZGF0YSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGVuZCAoY2h1bmspIHtcbiAgICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICAgIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH1cblxuICAgIGlmIChjaHVuayAmJiBjaHVuay5sZW5ndGgpIHtcbiAgICAgIHRoaXMuc2VuZChjaHVuaylcbiAgICB9XG5cbiAgICAvLyByZWRpcmVjdCBvdXRwdXQgZnJvbSB0aGUgc2VydmVyIHRvIF9hY3Rpb25TdHJlYW1cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG5cbiAgICAvLyBpbmRpY2F0ZSB0aGF0IHRoZSBzdHJlYW0gaGFzIGVuZGVkIGJ5IHNlbmRpbmcgYSBzaW5nbGUgZG90IG9uIGl0cyBvd24gbGluZVxuICAgIC8vIGlmIHRoZSBjbGllbnQgYWxyZWFkeSBjbG9zZWQgdGhlIGRhdGEgd2l0aCBcXHJcXG4gbm8gbmVlZCB0byBkbyBpdCBhZ2FpblxuICAgIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzID09PSAnXFxyXFxuJykge1xuICAgICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyAuXFxyXFxuXG4gICAgfSBlbHNlIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXHInKSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcbi5cXHJcXG5cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDBELCAweDBBLCAweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyBcXHJcXG4uXFxyXFxuXG4gICAgfVxuXG4gICAgLy8gZW5kIGRhdGEgbW9kZSwgcmVzZXQgdGhlIHZhcmlhYmxlcyBmb3IgZXh0ZW5kaW5nIHRoZSB0aW1lb3V0IGluIGRhdGEgbW9kZVxuICAgIHRoaXMuX2RhdGFNb2RlID0gZmFsc2VcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSBmYWxzZVxuXG4gICAgcmV0dXJuIHRoaXMud2FpdERyYWluXG4gIH1cblxuICAvLyBQUklWQVRFIE1FVEhPRFNcblxuICAvKipcbiAgICogUXVldWUgc29tZSBkYXRhIGZyb20gdGhlIHNlcnZlciBmb3IgcGFyc2luZy5cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIENodW5rIG9mIGRhdGEgcmVjZWl2ZWQgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICBfcGFyc2UgKGNodW5rKSB7XG4gICAgLy8gTGluZXMgc2hvdWxkIGFsd2F5cyBlbmQgd2l0aCA8Q1I+PExGPiBidXQgeW91IG5ldmVyIGtub3csIG1pZ2h0IGJlIG9ubHkgPExGPiBhcyB3ZWxsXG4gICAgdmFyIGxpbmVzID0gKHRoaXMuX3BhcnNlUmVtYWluZGVyICsgKGNodW5rIHx8ICcnKSkuc3BsaXQoL1xccj9cXG4vKVxuICAgIHRoaXMuX3BhcnNlUmVtYWluZGVyID0gbGluZXMucG9wKCkgLy8gbm90IHN1cmUgaWYgdGhlIGxpbmUgaGFzIGNvbXBsZXRlbHkgYXJyaXZlZCB5ZXRcblxuICAgIGZvciAobGV0IGkgPSAwLCBsZW4gPSBsaW5lcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgICAgaWYgKCFsaW5lc1tpXS50cmltKCkpIHtcbiAgICAgICAgLy8gbm90aGluZyB0byBjaGVjaywgZW1wdHkgbGluZVxuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuXG4gICAgICAvLyBwb3NzaWJsZSBpbnB1dCBzdHJpbmdzIGZvciB0aGUgcmVnZXg6XG4gICAgICAvLyAyNTAtTVVMVElMSU5FIFJFUExZXG4gICAgICAvLyAyNTAgTEFTVCBMSU5FIE9GIFJFUExZXG4gICAgICAvLyAyNTAgMS4yLjMgTUVTU0FHRVxuXG4gICAgICBjb25zdCBtYXRjaCA9IGxpbmVzW2ldLm1hdGNoKC9eKFxcZHszfSkoWy0gXSkoPzooXFxkK1xcLlxcZCtcXC5cXGQrKSg/OiApKT8oLiopLylcblxuICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgIHRoaXMuX3BhcnNlQmxvY2suZGF0YS5wdXNoKG1hdGNoWzRdKVxuXG4gICAgICAgIGlmIChtYXRjaFsyXSA9PT0gJy0nKSB7XG4gICAgICAgICAgLy8gdGhpcyBpcyBhIG11bHRpbGluZSByZXBseVxuICAgICAgICAgIHRoaXMuX3BhcnNlQmxvY2suc3RhdHVzQ29kZSA9IHRoaXMuX3BhcnNlQmxvY2suc3RhdHVzQ29kZSB8fCBOdW1iZXIobWF0Y2hbMV0pXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3Qgc3RhdHVzQ29kZSA9IE51bWJlcihtYXRjaFsxXSkgfHwgMFxuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0ge1xuICAgICAgICAgICAgc3RhdHVzQ29kZSxcbiAgICAgICAgICAgIGRhdGE6IHRoaXMuX3BhcnNlQmxvY2suZGF0YS5qb2luKCdcXG4nKSxcbiAgICAgICAgICAgIHN1Y2Nlc3M6IHN0YXR1c0NvZGUgPj0gMjAwICYmIHN0YXR1c0NvZGUgPCAzMDBcbiAgICAgICAgICB9XG5cbiAgICAgICAgICB0aGlzLl9vbkNvbW1hbmQocmVzcG9uc2UpXG4gICAgICAgICAgdGhpcy5fcGFyc2VCbG9jayA9IHtcbiAgICAgICAgICAgIGRhdGE6IFtdLFxuICAgICAgICAgICAgc3RhdHVzQ29kZTogbnVsbFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5fb25Db21tYW5kKHtcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICBzdGF0dXNDb2RlOiB0aGlzLl9wYXJzZUJsb2NrLnN0YXR1c0NvZGUgfHwgbnVsbCxcbiAgICAgICAgICBkYXRhOiBbbGluZXNbaV1dLmpvaW4oJ1xcbicpXG4gICAgICAgIH0pXG4gICAgICAgIHRoaXMuX3BhcnNlQmxvY2sgPSB7XG4gICAgICAgICAgZGF0YTogW10sXG4gICAgICAgICAgc3RhdHVzQ29kZTogbnVsbFxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gRVZFTlQgSEFORExFUlMgRk9SIFRIRSBTT0NLRVRcblxuICAvKipcbiAgICogQ29ubmVjdGlvbiBsaXN0ZW5lciB0aGF0IGlzIHJ1biB3aGVuIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaXMgb3BlbmVkLlxuICAgKiBTZXRzIHVwIGRpZmZlcmVudCBldmVudCBoYW5kbGVycyBmb3IgdGhlIG9wZW5lZCBzb2NrZXRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gICAqL1xuICBfb25PcGVuIChldmVudCkge1xuICAgIGlmIChldmVudCAmJiBldmVudC5kYXRhICYmIGV2ZW50LmRhdGEucHJveHlIb3N0bmFtZSkge1xuICAgICAgdGhpcy5vcHRpb25zLm5hbWUgPSBldmVudC5kYXRhLnByb3h5SG9zdG5hbWVcbiAgICB9XG5cbiAgICB0aGlzLnNvY2tldC5vbmRhdGEgPSB0aGlzLl9vbkRhdGEuYmluZCh0aGlzKVxuXG4gICAgdGhpcy5zb2NrZXQub25jbG9zZSA9IHRoaXMuX29uQ2xvc2UuYmluZCh0aGlzKVxuICAgIHRoaXMuc29ja2V0Lm9uZHJhaW4gPSB0aGlzLl9vbkRyYWluLmJpbmQodGhpcylcblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25HcmVldGluZ1xuICB9XG5cbiAgLyoqXG4gICAqIERhdGEgbGlzdGVuZXIgZm9yIGNodW5rcyBvZiBkYXRhIGVtaXR0ZWQgYnkgdGhlIHNlcnZlclxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGBldnQuZGF0YWAgZm9yIHRoZSBjaHVuayByZWNlaXZlZFxuICAgKi9cbiAgX29uRGF0YSAoZXZ0KSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcbiAgICB2YXIgc3RyaW5nUGF5bG9hZCA9IG5ldyBUZXh0RGVjb2RlcignVVRGLTgnKS5kZWNvZGUobmV3IFVpbnQ4QXJyYXkoZXZ0LmRhdGEpKVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NFUlZFUjogJyArIHN0cmluZ1BheWxvYWQpXG4gICAgdGhpcy5fcGFyc2Uoc3RyaW5nUGF5bG9hZClcbiAgfVxuXG4gIC8qKlxuICAgKiBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQsIGB3YWl0RHJhaW5gIGlzIHJlc2V0IHRvIGZhbHNlXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uRHJhaW4gKCkge1xuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2VcbiAgICB0aGlzLm9uZHJhaW4oKVxuICB9XG5cbiAgLyoqXG4gICAqIEVycm9yIGhhbmRsZXIgZm9yIHRoZSBzb2NrZXRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIFNlZSBldnQuZGF0YSBmb3IgdGhlIGVycm9yXG4gICAqL1xuICBfb25FcnJvciAoZXZ0KSB7XG4gICAgaWYgKGV2dCBpbnN0YW5jZW9mIEVycm9yICYmIGV2dC5tZXNzYWdlKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dClcbiAgICAgIHRoaXMub25lcnJvcihldnQpXG4gICAgfSBlbHNlIGlmIChldnQgJiYgZXZ0LmRhdGEgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBldnQuZGF0YSlcbiAgICAgIHRoaXMub25lcnJvcihldnQuZGF0YSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBuZXcgRXJyb3IoKGV2dCAmJiBldnQuZGF0YSAmJiBldnQuZGF0YS5tZXNzYWdlKSB8fCBldnQuZGF0YSB8fCBldnQgfHwgJ0Vycm9yJykpXG4gICAgICB0aGlzLm9uZXJyb3IobmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICAgIH1cblxuICAgIHRoaXMuY2xvc2UoKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IHRoZSBzb2NrZXQgaGFzIGJlZW4gY2xvc2VkXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uQ2xvc2UgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NvY2tldCBjbG9zZWQuJylcbiAgICB0aGlzLl9kZXN0cm95KClcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGlzIGlzIG5vdCBhIHNvY2tldCBkYXRhIGhhbmRsZXIgYnV0IHRoZSBoYW5kbGVyIGZvciBkYXRhIGVtaXR0ZWQgYnkgdGhlIHBhcnNlcixcbiAgICogc28gdGhpcyBkYXRhIGlzIHNhZmUgdG8gdXNlIGFzIGl0IGlzIGFsd2F5cyBjb21wbGV0ZSAoc2VydmVyIG1pZ2h0IHNlbmQgcGFydGlhbCBjaHVua3MpXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgZGF0YVxuICAgKi9cbiAgX29uQ29tbWFuZCAoY29tbWFuZCkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5fY3VycmVudEFjdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbihjb21tYW5kKVxuICAgIH1cbiAgfVxuXG4gIF9vblRpbWVvdXQgKCkge1xuICAgIC8vIGluZm9ybSBhYm91dCB0aGUgdGltZW91dCBhbmQgc2h1dCBkb3duXG4gICAgdmFyIGVycm9yID0gbmV3IEVycm9yKCdTb2NrZXQgdGltZWQgb3V0IScpXG4gICAgdGhpcy5fb25FcnJvcihlcnJvcilcbiAgfVxuXG4gIC8qKlxuICAgKiBFbnN1cmVzIHRoYXQgdGhlIGNvbm5lY3Rpb24gaXMgY2xvc2VkIGFuZCBzdWNoXG4gICAqL1xuICBfZGVzdHJveSAoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcblxuICAgIGlmICghdGhpcy5kZXN0cm95ZWQpIHtcbiAgICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgICAgdGhpcy5vbmNsb3NlKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2VuZHMgYSBzdHJpbmcgdG8gdGhlIHNvY2tldC5cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAgICovXG4gIF9zZW5kU3RyaW5nIChjaHVuaykge1xuICAgIC8vIGVzY2FwZSBkb3RzXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuZGlzYWJsZUVzY2FwaW5nKSB7XG4gICAgICBjaHVuayA9IGNodW5rLnJlcGxhY2UoL1xcblxcLi9nLCAnXFxuLi4nKVxuICAgICAgaWYgKCh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXG4nIHx8ICF0aGlzLl9sYXN0RGF0YUJ5dGVzKSAmJiBjaHVuay5jaGFyQXQoMCkgPT09ICcuJykge1xuICAgICAgICBjaHVuayA9ICcuJyArIGNodW5rXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gS2VlcGluZyBleWUgb24gdGhlIGxhc3QgYnl0ZXMgc2VudCwgdG8gc2VlIGlmIHRoZXJlIGlzIGEgPENSPjxMRj4gc2VxdWVuY2VcbiAgICAvLyBhdCB0aGUgZW5kIHdoaWNoIGlzIG5lZWRlZCB0byBlbmQgdGhlIGRhdGEgc3RyZWFtXG4gICAgaWYgKGNodW5rLmxlbmd0aCA+IDIpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSBjaHVuay5zdWJzdHIoLTIpXG4gICAgfSBlbHNlIGlmIChjaHVuay5sZW5ndGggPT09IDEpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSB0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgKyBjaHVua1xuICAgIH1cblxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgJyArIGNodW5rLmxlbmd0aCArICcgYnl0ZXMgb2YgcGF5bG9hZCcpXG5cbiAgICAvLyBwYXNzIHRoZSBjaHVuayB0byB0aGUgc29ja2V0XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoY2h1bmspLmJ1ZmZlcilcbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGEgc3RyaW5nIGNvbW1hbmQgdG8gdGhlIHNlcnZlciwgYWxzbyBhcHBlbmQgXFxyXFxuIGlmIG5lZWRlZFxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIFN0cmluZyB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIF9zZW5kQ29tbWFuZCAoc3RyKSB7XG4gICAgY29uc29sZS5sb2coJ19zZW5kQ29tbWFuZCcsIHN0cilcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFRleHRFbmNvZGVyKCdVVEYtOCcpLmVuY29kZShzdHIgKyAoc3RyLnN1YnN0cigtMikgIT09ICdcXHJcXG4nID8gJ1xcclxcbicgOiAnJykpLmJ1ZmZlcilcbiAgfVxuXG4gIF9zZW5kIChidWZmZXIpIHtcbiAgICB0aGlzLl9zZXRUaW1lb3V0KGJ1ZmZlci5ieXRlTGVuZ3RoKVxuICAgIHJldHVybiB0aGlzLnNvY2tldC5zZW5kKGJ1ZmZlcilcbiAgfVxuXG4gIF9zZXRUaW1lb3V0IChieXRlTGVuZ3RoKSB7XG4gICAgdmFyIHByb2xvbmdQZXJpb2QgPSBNYXRoLmZsb29yKGJ5dGVMZW5ndGggKiB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyKVxuICAgIHZhciB0aW1lb3V0XG5cbiAgICBpZiAodGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHdlJ3JlIGluIGRhdGEgbW9kZSwgc28gd2UgY291bnQgb25seSBvbmUgdGltZW91dCB0aGF0IGdldCBleHRlbmRlZCBmb3IgZXZlcnkgc2VuZCgpLlxuICAgICAgdmFyIG5vdyA9IERhdGUubm93KClcblxuICAgICAgLy8gdGhlIG9sZCB0aW1lb3V0IHN0YXJ0IHRpbWVcbiAgICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCB8fCBub3dcblxuICAgICAgLy8gdGhlIG9sZCB0aW1lb3V0IHBlcmlvZCwgbm9ybWFsaXplZCB0byBhIG1pbmltdW0gb2YgVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSAodGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCB8fCB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kKSArIHByb2xvbmdQZXJpb2RcblxuICAgICAgLy8gdGhlIG5ldyB0aW1lb3V0IGlzIHRoZSBkZWx0YSBiZXR3ZWVuIHRoZSBuZXcgZmlyaW5nIHRpbWUgKD0gdGltZW91dCBwZXJpb2QgKyB0aW1lb3V0IHN0YXJ0IHRpbWUpIGFuZCBub3dcbiAgICAgIHRpbWVvdXQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgKyB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kIC0gbm93XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHNldCBuZXcgdGltb3V0XG4gICAgICB0aW1lb3V0ID0gdGhpcy50aW1lb3V0U29ja2V0TG93ZXJCb3VuZCArIHByb2xvbmdQZXJpb2RcbiAgICB9XG5cbiAgICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKSAvLyBjbGVhciBwZW5kaW5nIHRpbWVvdXRzXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gc2V0VGltZW91dCh0aGlzLl9vblRpbWVvdXQuYmluZCh0aGlzKSwgdGltZW91dCkgLy8gYXJtIHRoZSBuZXh0IHRpbWVvdXRcbiAgfVxuXG4gIC8qKlxuICAgKiBJbnRpdGlhdGUgYXV0aGVudGljYXRpb24gc2VxdWVuY2UgaWYgbmVlZGVkXG4gICAqL1xuICBfYXV0aGVudGljYXRlVXNlciAoKSB7XG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aCkge1xuICAgICAgLy8gbm8gbmVlZCB0byBhdXRoZW50aWNhdGUsIGF0IGxlYXN0IG5vIGRhdGEgZ2l2ZW5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB2YXIgYXV0aFxuXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCAmJiB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSB7XG4gICAgICB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCA9ICdYT0FVVEgyJ1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCkge1xuICAgICAgYXV0aCA9IHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kLnRvVXBwZXJDYXNlKCkudHJpbSgpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHVzZSBmaXJzdCBzdXBwb3J0ZWRcbiAgICAgIGF1dGggPSAodGhpcy5fc3VwcG9ydGVkQXV0aFswXSB8fCAnUExBSU4nKS50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICAgIH1cblxuICAgIHN3aXRjaCAoYXV0aCkge1xuICAgICAgY2FzZSAnTE9HSU4nOlxuICAgICAgICAvLyBMT0dJTiBpcyBhIDMgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAgIC8vIEM6IEFVVEggTE9HSU5cbiAgICAgICAgLy8gQzogQkFTRTY0KFVTRVIpXG4gICAgICAgIC8vIEM6IEJBU0U2NChQQVNTKVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBMT0dJTicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVJcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0FVVEggTE9HSU4nKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ1BMQUlOJzpcbiAgICAgICAgLy8gQVVUSCBQTEFJTiBpcyBhIDEgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAgIC8vIEM6IEFVVEggUExBSU4gQkFTRTY0KFxcMCBVU0VSIFxcMCBQQVNTKVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBQTEFJTicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoXG4gICAgICAgICAgLy8gY29udmVydCB0byBCQVNFNjRcbiAgICAgICAgICAnQVVUSCBQTEFJTiAnICtcbiAgICAgICAgICBlbmNvZGUoXG4gICAgICAgICAgICAvLyB0aGlzLm9wdGlvbnMuYXV0aC51c2VyKydcXHUwMDAwJytcbiAgICAgICAgICAgICdcXHUwMDAwJyArIC8vIHNraXAgYXV0aG9yaXphdGlvbiBpZGVudGl0eSBhcyBpdCBjYXVzZXMgcHJvYmxlbXMgd2l0aCBzb21lIHNlcnZlcnNcbiAgICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnVzZXIgKyAnXFx1MDAwMCcgK1xuICAgICAgICAgICAgdGhpcy5vcHRpb25zLmF1dGgucGFzcylcbiAgICAgICAgKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ1hPQVVUSDInOlxuICAgICAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vZ21haWwveG9hdXRoMl9wcm90b2NvbCNzbXRwX3Byb3RvY29sX2V4Y2hhbmdlXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIFhPQVVUSDInKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9YT0FVVEgyXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIFhPQVVUSDIgJyArIHRoaXMuX2J1aWxkWE9BdXRoMlRva2VuKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIsIHRoaXMub3B0aW9ucy5hdXRoLnhvYXV0aDIpKVxuICAgICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignVW5rbm93biBhdXRoZW50aWNhdGlvbiBtZXRob2QgJyArIGF1dGgpKVxuICB9XG5cbiAgLy8gQUNUSU9OUyBGT1IgUkVTUE9OU0VTIEZST00gVEhFIFNNVFAgU0VSVkVSXG5cbiAgLyoqXG4gICAqIEluaXRpYWwgcmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBtdXN0IGhhdmUgYSBzdGF0dXMgMjIwXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25HcmVldGluZyAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDIyMCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgZ3JlZXRpbmc6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0aW9ucy5sbXRwKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIExITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTEhMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0xITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIEVITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBMSExPXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25MSExPIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xITE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFByb2Nlc3MgYXMgRUhMTyByZXNwb25zZVxuICAgIHRoaXMuX2FjdGlvbkVITE8oY29tbWFuZClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBFSExPLiBJZiB0aGUgcmVzcG9uc2UgaXMgYW4gZXJyb3IsIHRyeSBIRUxPIGluc3RlYWRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkVITE8gKGNvbW1hbmQpIHtcbiAgICB2YXIgbWF0Y2hcblxuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICBpZiAoIXRoaXMuX3NlY3VyZU1vZGUgJiYgdGhpcy5vcHRpb25zLnJlcXVpcmVUTFMpIHtcbiAgICAgICAgdmFyIGVyck1zZyA9ICdTVEFSVFRMUyBub3Qgc3VwcG9ydGVkIHdpdGhvdXQgRUhMTydcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBlcnJNc2cpXG4gICAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGVyck1zZykpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBUcnkgSEVMTyBpbnN0ZWFkXG4gICAgICB0aGlzLmxvZ2dlci53YXJuaW5nKERFQlVHX1RBRywgJ0VITE8gbm90IHN1Y2Nlc3NmdWwsIHRyeWluZyBIRUxPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25IRUxPXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBQTEFJTiBhdXRoXG4gICAgaWYgKGNvbW1hbmQuZGF0YS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVBMQUlOL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBQTEFJTicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1BMQUlOJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBMT0dJTiBhdXRoXG4gICAgaWYgKGNvbW1hbmQuZGF0YS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKUxPR0lOL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBMT0dJTicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ0xPR0lOJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBYT0FVVEgyIGF1dGhcbiAgICBpZiAoY29tbWFuZC5kYXRhLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspWE9BVVRIMi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggWE9BVVRIMicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1hPQVVUSDInKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBtYXhpbXVtIGFsbG93ZWQgbWVzc2FnZSBzaXplXG4gICAgaWYgKChtYXRjaCA9IGNvbW1hbmQuZGF0YS5tYXRjaCgvU0laRSAoXFxkKykvaSkpICYmIE51bWJlcihtYXRjaFsxXSkpIHtcbiAgICAgIGNvbnN0IG1heEFsbG93ZWRTaXplID0gTnVtYmVyKG1hdGNoWzFdKVxuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTWF4aW11bSBhbGxvd2QgbWVzc2FnZSBzaXplOiAnICsgbWF4QWxsb3dlZFNpemUpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgU1RBUlRUTFNcbiAgICBpZiAoIXRoaXMuX3NlY3VyZU1vZGUpIHtcbiAgICAgIGlmICgoY29tbWFuZC5kYXRhLm1hdGNoKC9TVEFSVFRMU1xccz8kL21pKSAmJiAhdGhpcy5vcHRpb25zLmlnbm9yZVRMUykgfHwgISF0aGlzLm9wdGlvbnMucmVxdWlyZVRMUykge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU1RBUlRUTFNcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBTVEFSVFRMUycpXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdTVEFSVFRMUycpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuICB9XG5cbiAgLyoqXG4gICAqIEhhbmRsZXMgc2VydmVyIHJlc3BvbnNlIGZvciBTVEFSVFRMUyBjb21tYW5kLiBJZiB0aGVyZSdzIGFuIGVycm9yXG4gICAqIHRyeSBIRUxPIGluc3RlYWQsIG90aGVyd2lzZSBpbml0aWF0ZSBUTFMgdXBncmFkZS4gSWYgdGhlIHVwZ3JhZGVcbiAgICogc3VjY2VlZGVzIHJlc3RhcnQgdGhlIEVITE9cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHN0ciBNZXNzYWdlIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgX2FjdGlvblNUQVJUVExTIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ1NUQVJUVExTIG5vdCBzdWNjZXNzZnVsJylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9zZWN1cmVNb2RlID0gdHJ1ZVxuICAgIHRoaXMuc29ja2V0LnVwZ3JhZGVUb1NlY3VyZSgpXG5cbiAgICAvLyByZXN0YXJ0IHByb3RvY29sIGZsb3dcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBIRUxPXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25IRUxPIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0hFTE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIExPR0lOLCBpZiBzdWNjZXNzZnVsIGV4cGVjdHMgYmFzZTY0IGVuY29kZWQgdXNlcm5hbWVcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDMzNCB8fCBjb21tYW5kLmRhdGEgIT09ICdWWE5sY201aGJXVTYnKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdBVVRIIExPR0lOIFVTRVIgbm90IHN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBsb2dpbiBzZXF1ZW5jZSB3aGlsZSB3YWl0aW5nIGZvciBcIjMzNCBWWE5sY201aGJXVTYgXCI6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBzdWNjZXNzZnVsJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9QQVNTXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoZW5jb2RlKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIpKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4gdXNlcm5hbWUsIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCBwYXNzd29yZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9MT0dJTl9QQVNTIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1VHRnpjM2R2Y21RNicpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gUEFTUyBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFVHRnpjM2R2Y21RNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgucGFzcykpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBYT0FVVEgyIHRva2VuLCBpZiBlcnJvciBvY2N1cnMgc2VuZCBlbXB0eSByZXNwb25zZVxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9YT0FVVEgyIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLndhcm5pbmcoREVCVUdfVEFHLCAnRXJyb3IgZHVyaW5nIEFVVEggWE9BVVRIMiwgc2VuZGluZyBlbXB0eSByZXNwb25zZScpXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnJylcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlKGNvbW1hbmQpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrcyBpZiBhdXRoZW50aWNhdGlvbiBzdWNjZWVkZWQgb3Igbm90LiBJZiBzdWNjZXNzZnVsbHkgYXV0aGVudGljYXRlZFxuICAgKiBlbWl0IGBpZGxlYCB0byBpbmRpY2F0ZSB0aGF0IGFuIGUtbWFpbCBjYW4gYmUgc2VudCB1c2luZyB0aGlzIGNvbm5lY3Rpb25cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhDb21wbGV0ZSAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBmYWlsZWQ6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gc3VjY2Vzc2Z1bC4nKVxuXG4gICAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gdGhpcy5vcHRpb25zLmF1dGgudXNlclxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG4gIH1cblxuICAvKipcbiAgICogVXNlZCB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGlkbGUgYW5kIHRoZSBzZXJ2ZXIgZW1pdHMgdGltZW91dFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uSWRsZSAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgPiAzMDApIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIE1BSUwgRlJPTSBjb21tYW5kLiBQcm9jZWVkIHRvIGRlZmluaW5nIFJDUFQgVE8gbGlzdCBpZiBzdWNjZXNzZnVsXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25NQUlMIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01BSUwgRlJPTSB1bnN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBubyByZWNpcGllbnRzIGRlZmluZWQnKSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHN1Y2Nlc3NmdWwsIHByb2NlZWRpbmcgd2l0aCAnICsgdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCArICcgcmVjaXBpZW50cycpXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIGEgUkNQVCBUTyBjb21tYW5kLiBJZiB0aGUgY29tbWFuZCBpcyB1bnN1Y2Nlc3NmdWwsIHRyeSB0aGUgbmV4dCBvbmUsXG4gICAqIGFzIHRoaXMgbWlnaHQgYmUgcmVsYXRlZCBvbmx5IHRvIHRoZSBjdXJyZW50IHJlY2lwaWVudCwgbm90IGEgZ2xvYmFsIGVycm9yLCBzb1xuICAgKiB0aGUgZm9sbG93aW5nIHJlY2lwaWVudHMgbWlnaHQgc3RpbGwgYmUgdmFsaWRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvblJDUFQgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIud2FybmluZyhERUJVR19UQUcsICdSQ1BUIFRPIGZhaWxlZCBmb3I6ICcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gICAgICAvLyB0aGlzIGlzIGEgc29mdCBlcnJvclxuICAgICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLmxlbmd0aCA8IHRoaXMuX2VudmVsb3BlLnRvLmxlbmd0aCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uREFUQVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdSQ1BUIFRPIGRvbmUsIHByb2NlZWRpbmcgd2l0aCBwYXlsb2FkJylcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0RBVEEnKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0NhblxcJ3Qgc2VuZCBtYWlsIC0gYWxsIHJlY2lwaWVudHMgd2VyZSByZWplY3RlZCcpKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIHRoZSBEQVRBIGNvbW1hbmQuIFNlcnZlciBpcyBub3cgd2FpdGluZyBmb3IgYSBtZXNzYWdlLCBzbyBlbWl0IGBvbnJlYWR5YFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uREFUQSAoY29tbWFuZCkge1xuICAgIC8vIHJlc3BvbnNlIHNob3VsZCBiZSAzNTQgYnV0IGFjY29yZGluZyB0byB0aGlzIGlzc3VlIGh0dHBzOi8vZ2l0aHViLmNvbS9lbGVpdGgvZW1haWxqcy9pc3N1ZXMvMjRcbiAgICAvLyBzb21lIHNlcnZlcnMgbWlnaHQgdXNlIDI1MCBpbnN0ZWFkXG4gICAgaWYgKFsyNTAsIDM1NF0uaW5kZXhPZihjb21tYW5kLnN0YXR1c0NvZGUpIDwgMCkge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnREFUQSB1bnN1Y2Nlc3NmdWwgJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9kYXRhTW9kZSA9IHRydWVcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25yZWFkeSh0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIGZyb20gdGhlIHNlcnZlciwgb25jZSB0aGUgbWVzc2FnZSBzdHJlYW0gaGFzIGVuZGVkIHdpdGggPENSPjxMRj4uPENSPjxMRj5cbiAgICogRW1pdHMgYG9uZG9uZWAuXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25TdHJlYW0gKGNvbW1hbmQpIHtcbiAgICB2YXIgcmNwdFxuXG4gICAgaWYgKHRoaXMub3B0aW9ucy5sbXRwKSB7XG4gICAgICAvLyBMTVRQIHJldHVybnMgYSByZXNwb25zZSBjb2RlIGZvciAqZXZlcnkqIHN1Y2Nlc3NmdWxseSBzZXQgcmVjaXBpZW50XG4gICAgICAvLyBGb3IgZXZlcnkgcmVjaXBpZW50IHRoZSBtZXNzYWdlIG1pZ2h0IHN1Y2NlZWQgb3IgZmFpbCBpbmRpdmlkdWFsbHlcblxuICAgICAgcmNwdCA9IHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUuc2hpZnQoKVxuICAgICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTG9jYWwgZGVsaXZlcnkgdG8gJyArIHJjcHQgKyAnIGZhaWxlZC4nKVxuICAgICAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2gocmNwdClcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xvY2FsIGRlbGl2ZXJ5IHRvICcgKyByY3B0ICsgJyBzdWNjZWVkZWQuJylcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uZG9uZSh0cnVlKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBGb3IgU01UUCB0aGUgbWVzc2FnZSBlaXRoZXIgZmFpbHMgb3Igc3VjY2VlZHMsIHRoZXJlIGlzIG5vIGluZm9ybWF0aW9uXG4gICAgICAvLyBhYm91dCBpbmRpdmlkdWFsIHJlY2lwaWVudHNcblxuICAgICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTWVzc2FnZSBzZW5kaW5nIGZhaWxlZC4nKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTWVzc2FnZSBzZW50IHN1Y2Nlc3NmdWxseS4nKVxuICAgICAgfVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmRvbmUoISFjb21tYW5kLnN1Y2Nlc3MpXG4gICAgfVxuXG4gICAgLy8gSWYgdGhlIGNsaWVudCB3YW50ZWQgdG8gZG8gc29tZXRoaW5nIGVsc2UgKGVnLiB0byBxdWl0KSwgZG8gbm90IGZvcmNlIGlkbGVcbiAgICBpZiAodGhpcy5fY3VycmVudEFjdGlvbiA9PT0gdGhpcy5fYWN0aW9uSWRsZSkge1xuICAgICAgLy8gV2FpdGluZyBmb3IgbmV3IGNvbm5lY3Rpb25zXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdJZGxpbmcgd2hpbGUgd2FpdGluZyBmb3IgbmV3IGNvbm5lY3Rpb25zLi4uJylcbiAgICAgIHRoaXMub25pZGxlKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQnVpbGRzIGEgbG9naW4gdG9rZW4gZm9yIFhPQVVUSDIgYXV0aGVudGljYXRpb24gY29tbWFuZFxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gdXNlciBFLW1haWwgYWRkcmVzcyBvZiB0aGUgdXNlclxuICAgKiBAcGFyYW0ge1N0cmluZ30gdG9rZW4gVmFsaWQgYWNjZXNzIHRva2VuIGZvciB0aGUgdXNlclxuICAgKiBAcmV0dXJuIHtTdHJpbmd9IEJhc2U2NCBmb3JtYXR0ZWQgbG9naW4gdG9rZW5cbiAgICovXG4gIF9idWlsZFhPQXV0aDJUb2tlbiAodXNlciwgdG9rZW4pIHtcbiAgICB2YXIgYXV0aERhdGEgPSBbXG4gICAgICAndXNlcj0nICsgKHVzZXIgfHwgJycpLFxuICAgICAgJ2F1dGg9QmVhcmVyICcgKyB0b2tlbixcbiAgICAgICcnLFxuICAgICAgJydcbiAgICBdXG4gICAgLy8gYmFzZTY0KFwidXNlcj17VXNlcn1cXHgwMGF1dGg9QmVhcmVyIHtUb2tlbn1cXHgwMFxceDAwXCIpXG4gICAgcmV0dXJuIGVuY29kZShhdXRoRGF0YS5qb2luKCdcXHgwMScpKVxuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFNtdHBDbGllbnRcbiJdfQ==