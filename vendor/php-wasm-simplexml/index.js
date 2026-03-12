const importMeta = import.meta;
const url = new URL(importMeta.url);
const ini = !!(Number(  url.searchParams.get('ini') ?? true  ));
const moduleRoot = new URL('./', importMeta.url);

export const getLibs = php => [
	{url: new URL(`./php${php.phpVersion}-simplexml.so`, moduleRoot), ini},
];
