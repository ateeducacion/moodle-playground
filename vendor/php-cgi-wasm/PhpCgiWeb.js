import { PhpCgiWebBase } from './PhpCgiWebBase.js';
import PHP from './php-cgi-worker.js';

export class PhpCgiWeb extends PhpCgiWebBase
{
	constructor({docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args} = {})
	{
		super(PHP, {docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args});
	}
}
