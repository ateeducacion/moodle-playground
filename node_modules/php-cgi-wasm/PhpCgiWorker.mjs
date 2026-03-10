import { PhpCgiWebBase } from './PhpCgiWebBase.mjs';
import PHP from './php-cgi-worker.mjs';

export class PhpCgiWorker extends PhpCgiWebBase
{
	constructor({docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args} = {})
	{
		super(PHP, {docroot, prefix, rewrite, cookies, types, onRequest, notFound, ...args});
	}
}
