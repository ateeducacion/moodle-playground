console.info('Deprecated. Use php-tags.js');

const importMeta = import.meta;
import(new URL('./PhpWeb.js', importMeta.url) + '').then(({runPhpTags}) => runPhpTags(document));
