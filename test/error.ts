import {promisify} from 'util';
import net = require('net');
import http = require('http');
import stream = require('stream');
import test from 'ava';
import getStream = require('get-stream');
import is from '@sindresorhus/is';
import got, {RequestError, HTTPError, TimeoutError} from '../source';
import withServer from './helpers/with-server';

const pStreamPipeline = promisify(stream.pipeline);

test('properties', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const url = new URL(server.url);

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.truthy(error);
	t.truthy(error.response);
	t.truthy(error.options);
	t.false({}.propertyIsEnumerable.call(error, 'options'));
	t.false({}.propertyIsEnumerable.call(error, 'response'));
	// This fails because of TS 3.7.2 useDefineForClassFields
	// Class fields will always be initialized, even though they are undefined
	// A test to check for undefined is in place below
	// t.false({}.hasOwnProperty.call(error, 'code'));
	t.is(error.code, 'ERR_NON_2XX_3XX_RESPONSE');
	t.is(error.message, 'Response code 404 (Not Found)');
	t.deepEqual(error.options.url, url);
	t.is(error.response.headers.connection, 'close');
	t.is(error.response.body, 'not');
});

test('catches dns errors', async t => {
	const error = await t.throwsAsync<RequestError>(got('http://doesntexist', {retry: 0}));
	t.truthy(error);
	t.regex(error.message, /ENOTFOUND|EAI_AGAIN/);
	t.is(error.options.url.host, 'doesntexist');
	t.is(error.options.method, 'GET');
	t.is(error.code, 'ENOTFOUND');
});

test('`options.body` form error message', async t => {
	// @ts-expect-error Error tests
	await t.throwsAsync(got.post('https://example.com', {body: Buffer.from('test'), form: ''}), {
		message: 'The `body`, `json` and `form` options are mutually exclusive'
	});
});

test('no plain object restriction on json body', withServer, async (t, server, got) => {
	server.post('/body', async (request, response) => {
		await pStreamPipeline(request, response);
	});

	class CustomObject {
		a = 123;
	}

	const body = await got.post('body', {json: new CustomObject()}).json();

	t.deepEqual(body, {a: 123});
});

test('default status message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 400);
	t.is(error.response.statusMessage, 'Bad Request');
});

test('custom status message', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 400;
		response.statusMessage = 'Something Exploded';
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 400);
	t.is(error.response.statusMessage, 'Something Exploded');
});

test('custom body', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end('not');
	});

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 404);
	t.is(error.response.body, 'not');
});

test('contains Got options', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const options: {agent: false} = {
		agent: false
	};

	const error = await t.throwsAsync<RequestError>(got(options));
	t.is(error.options.agent, options.agent);
});

test('empty status message is overriden by the default one', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.writeHead(400, '');
		response.end('body');
	});

	const error = await t.throwsAsync<HTTPError>(got(''));
	t.is(error.response.statusCode, 400);
	t.is(error.response.statusMessage, http.STATUS_CODES[400]);
});

test('`http.request` error', async t => {
	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw new TypeError('The header content contains invalid characters');
		}
	}), {
		instanceOf: got.RequestError,
		code: 'ERR_GEN_REQ_ERROR',
		message: 'The header content contains invalid characters'
	});
});

test('`http.request` pipe error', async t => {
	const message = 'snap!';

	await t.throwsAsync(got('https://example.com', {
		// @ts-expect-error Error tests
		request: () => {
			const proxy = new stream.PassThrough();

			const anyProxy = proxy as any;
			anyProxy.socket = {
				remoteAddress: '',
				prependOnceListener: () => {}
			};

			anyProxy.headers = {};

			anyProxy.abort = () => {};

			proxy.resume();
			proxy.read = () => {
				proxy.destroy(new Error(message));

				return null;
			};

			return proxy;
		},
		throwHttpErrors: false
	}), {
		instanceOf: got.RequestError,
		message
	});
});

test('`http.request` error through CacheableRequest', async t => {
	await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw new TypeError('The header content contains invalid characters');
		},
		cache: new Map()
	}), {
		instanceOf: got.RequestError,
		message: 'The header content contains invalid characters'
	});
});

test('errors are thrown directly when options.isStream is true', t => {
	t.throws(() => {
		// @ts-expect-error Error tests
		void got('https://example.com', {isStream: true, hooks: false});
	}, {
		message: 'Expected value which is `predicate returns truthy for any value`, received value of type `Array`.'
	});
});

test('normalization errors using convenience methods', async t => {
	const url = 'undefined/https://example.com';
	await t.throwsAsync(got(url).json().text().buffer(), {message: `Invalid URL: ${url}`});
});

test('errors can have request property', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.end();
	});

	const error = await t.throwsAsync<HTTPError>(got(''));

	t.truthy(error.response);
	t.truthy(error.request.downloadProgress);
});

test('promise does not hang on timeout on HTTP error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 404;
		response.write('asdf');
	});

	await t.throwsAsync(got({
		timeout: 100
	}), {
		instanceOf: TimeoutError,
		code: 'ETIMEDOUT'
	});
});

test('no uncaught parse errors', async t => {
	const server = net.createServer();

	const listen = promisify(server.listen.bind(server));
	const close = promisify(server.close.bind(server));

	// @ts-expect-error TS is sooo dumb. It doesn't need an argument at all.
	await listen();

	server.on('connection', socket => {
		socket.resume();
		socket.end([
			'HTTP/1.1 404 Not Found',
			'transfer-encoding: chunked',
			'',
			'0',
			'',
			''
		].join('\r\n'));
	});

	await t.throwsAsync(got.head(`http://localhost:${(server.address() as net.AddressInfo).port}`), {
		message: /^Parse Error/
	});

	await close();
});

// Fails randomly on Node 10:
// Blocked by https://github.com/istanbuljs/nyc/issues/619
// eslint-disable-next-line ava/no-skip-test
test.skip('the old stacktrace is recovered', async t => {
	const error = await t.throwsAsync(got('https://example.com', {
		request: () => {
			throw new Error('foobar');
		}
	}));

	t.true(error.stack!.includes('at Object.request'));

	// The first `at get` points to where the error was wrapped,
	// the second `at get` points to the real cause.
	t.not(error.stack!.indexOf('at get'), error.stack!.lastIndexOf('at get'));
});

test.serial('custom stack trace', withServer, async (t, _server, got) => {
	const ErrorCaptureStackTrace = Error.captureStackTrace;

	const enable = () => {
		Error.captureStackTrace = (target: {stack: any}) => {
			target.stack = [
				'line 1',
				'line 2'
			];
		};
	};

	const disable = () => {
		Error.captureStackTrace = ErrorCaptureStackTrace;
	};

	// Node.js default behavior
	{
		const stream = got.stream('');
		stream.destroy(new Error('oh no'));

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught.stack), 'string');
	}

	// Passing a custom error
	{
		enable();
		const error = new Error('oh no');
		disable();

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught.stack), 'string');
	}

	// Custom global behavior
	{
		enable();
		const error = new Error('oh no');

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught.stack), 'Array');

		disable();
	}

	// Passing a default error that needs some processing
	{
		const error = new Error('oh no');
		enable();

		const stream = got.stream('');
		stream.destroy(error);

		const caught = await t.throwsAsync(getStream(stream));
		t.is(is(caught.stack), 'Array');

		disable();
	}
});
