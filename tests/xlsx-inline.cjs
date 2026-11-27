/* Test helper (loaded with --require): the app writes text cells into xl/sharedStrings.xml, the standard Excel way
   (Google Sheets drops the spaces of inline strings). Many older tests search the sheet XML for text, so after
   JSZip.loadAsync each worksheet is given back with its shared strings written inline. Test-only; the files are untouched. */
const JSZip = require('jszip');
if (!JSZip.__wlfInline) {
  JSZip.__wlfInline = true;
  const load = JSZip.__rawLoadAsync = JSZip.loadAsync.bind(JSZip);
  const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  JSZip.loadAsync = async function (...args) {
    const zip = await load(...args), sst = zip.file('xl/sharedStrings.xml');
    if (!sst) return zip;
    const list = [...(await sst.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => unescape(t[1])).join(''));
    for (const name of Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      const xml = await zip.file(name).async('string');
      zip.file(name, xml.replace(/<c ([^>]*?)t="s"([^>]*)><v>(\d+)<\/v><\/c>/g, (_, a, b, i) => '<c ' + a + 't="inlineStr"' + b + '><is><t xml:space="preserve">' + escape(list[Number(i)] ?? '') + '</t></is></c>'));
    }
    return zip;
  };
}
module.exports = JSZip;
