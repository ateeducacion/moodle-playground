import { PhpCgiWebBase } from './PhpCgiWebBase.js';
import PHP from './php-cgi-webview.js';

export class PhpCgiWebview extends PhpCgiWebBase
{
	constructor({docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args} = {})
	{
		super(PHP, {docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args});
	}
}
