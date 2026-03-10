import { PhpCgiWebBase } from './PhpCgiWebBase.mjs';
import PHP from './php-cgi-webview.mjs';

export class PhpCgiWebview extends PhpCgiWebBase
{
	constructor({docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args} = {})
	{
		super(PHP, {docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args});
	}
}
