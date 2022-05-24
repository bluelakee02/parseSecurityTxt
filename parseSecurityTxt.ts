import { logger } from './logger';
import fetch, { Response } from 'node-fetch';
import { AbortSignal } from 'node-fetch/externals';
import { TextDecoder } from 'util';

const SECURITY_TXT_SIZE_LIMIT = 1024;
const LINKS_SIZE_LIMIT = 1024 * 1024;
const TIMEOUT_LIMIT = 10000;

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

export type SecurityTxtDocument = {
  contact: Array<string>;
  expires: string | Date | undefined;
  encryption?: Array<string>;
  acknowledgments?: Array<string>;
  preferredLanguages?: Array<string>;
  canonical?: string;
  policy?: Array<string>;
  hiring?: Array<string>;
};

export type SecurityTxtParsedDocument = Array<{ label: string; value?: string | Date; link?: string }>;

const stringIsAValidUrl = (s: string) => {
  try {
    new URL(s);
    return true;
  } catch (error) {
    logger.error({ err: error }, `[stringIsAValidUrl] invalid url`);
    return false;
  }
};

const urlExists = async (url: string) => {
  let response: Response | undefined = undefined;
  try {
    response = await fetch(url, { method: 'HEAD', timeout: TIMEOUT_LIMIT });
  } catch (error) {
    logger.error({ err: error }, `[urlExists] url does not exist`);
    return false;
  }
  return response && response.status === 200;
};

const isAMailToLink = (link: string) => /^mailto:*/.test(link);
const isAPhoneLink = (link: string) => /^tel:*/.test(link);

const parseTitle = (body: string) => {
  let match = body.match(/<title>([^<]*)<\/title>/);
  if (!match || typeof match[1] !== 'string') return '';
  return match[1];
};

const getPageTitle = async (url: string) => {
  const response = await fetch(url, { method: 'GET', size: LINKS_SIZE_LIMIT, timeout: TIMEOUT_LIMIT });
  return parseTitle(await response.text());
};

const parseSecurityTxtDocument = async (document: SecurityTxtDocument) => {
  const result: SecurityTxtParsedDocument = [];

  //Get all possible contacts
  for (const contact of document.contact) {
    if (isAMailToLink(contact) || isAPhoneLink(contact)) {
      result.push({ label: 'contact', value: contact });
    }
    if (stringIsAValidUrl(contact) && urlExists(contact)) {
      result.push({ label: await getPageTitle(contact), link: contact });
    }
  }

  result.push({ label: 'expires', value: document.expires });

  if (document.encryption) {
    for (const encryption of document.encryption) {
      result.push({ label: 'encryption', value: encryption });
    }
  }

  if (document.acknowledgments) {
    for (const acknowledgement of document.acknowledgments) {
      if (stringIsAValidUrl(acknowledgement) && urlExists(acknowledgement)) {
        result.push({ label: await getPageTitle(acknowledgement), link: acknowledgement });
      }
    }
  }

  if (document.preferredLanguages) {
    let languages = [];
    for (const language of document.preferredLanguages) {
      languages.push(languageNames.of(language));
    }
    result.push({ label: 'preferredLanguages', value: languages.join(', ') });
  }

  if (document.canonical) {
    result.push({ label: 'canonical', link: document.canonical });
  }

  if (document.policy) {
    for (const policy of document.policy) {
      if (stringIsAValidUrl(policy) && urlExists(policy)) {
        result.push({ label: await getPageTitle(policy), link: policy });
      }
    }
  }

  if (document.hiring) {
    for (const hiring of document.hiring) {
      if (stringIsAValidUrl(hiring) && urlExists(hiring)) {
        result.push({ label: await getPageTitle(hiring), link: hiring });
      }
    }
  }

  return result;
};

const parseLinesToObject = (lines: string[]) => {
  const result: SecurityTxtDocument = {
    contact: [],
    expires: undefined,
  };

  lines.forEach((line) => {
    if (line.startsWith('#')) return;

    const match = /^(?<key>.*): (?<value>.*)$/.exec(line);
    if (!match) return;

    const key = match?.groups?.key.toLowerCase();
    const value = match?.groups?.value;

    if (value) {
      switch (key) {
        case 'acknowledgments':
        case 'encryption':
        case 'hiring':
        case 'policy':
        case 'contact':
          if (result[key] !== undefined && Array.isArray(result[key])) {
            result[key]?.push(value);
          } else {
            result[key] = [value];
          }
          break;

        case 'canonical':
          if (result.canonical !== undefined) {
            throw new Error('There can only be one Canonical field');
          }
          result.canonical = value;
          break;

        case 'expires':
          if (result.expires !== undefined) {
            throw new Error('There can only be one Expires field');
          }
          let date = new Date(value);
          result.expires = !isNaN(date.getTime()) ? date : value;
          break;

        case 'preferred-languages':
          if (result.preferredLanguages != undefined) {
            throw new Error('There can only be one Preferred-Languages field');
          }
          result.preferredLanguages = [];
          value.split(',').forEach((lang) => result.preferredLanguages && result.preferredLanguages.push(lang.trim()));
          break;
      }
    }
  });
  return result;
};

const parseSecurityTxt = async (link: string) => {
  const controller = new AbortController();
  const decoder = new TextDecoder();
  let responseText = '';

  if (!stringIsAValidUrl(link)) {
    logger.error('ERROR invalid urls');
    return;
  }
  if (!(await urlExists(link))) {
    logger.error('ERROR url does not exist');
    return;
  }

  const response = await fetch(link, {
    method: 'GET',
    signal: controller.signal as AbortSignal,
    size: SECURITY_TXT_SIZE_LIMIT,
    timeout: TIMEOUT_LIMIT,
  });

  if (!response.headers.get('content-type')?.includes('text/plain')) {
    return;
  }

  let bytesWritten = 0;

  for await (const chunk of response.body) {
    if (typeof chunk !== 'string' && Buffer.isBuffer(chunk)) {
      bytesWritten += chunk.byteLength;
      if (bytesWritten > SECURITY_TXT_SIZE_LIMIT) {
        controller.abort();
        throw new Error(`content size at ${response.url} over limit`);
      }
      responseText += decoder.decode(chunk, { stream: true });
    }
  }

  responseText += decoder.decode();
  let lines = responseText.match(/[^\r\n]+/g) || [];
  const parsedLines = parseLinesToObject(lines);
  const parsedSecurityTxtDocument = await parseSecurityTxtDocument(parsedLines);
  console.log(parsedSecurityTxtDocument);
  return parseSecurityTxtDocument;
};

parseSecurityTxt('aaa');

parseSecurityTxt('https://githaaaub.com/.well-known/security.txta');
parseSecurityTxt('https://github.com/.well-known/security.txt');
parseSecurityTxt('http://www.unforgettable.dk/42.zip');
parseSecurityTxt('https://github.com/bluelakee02/test/raw/main/a.txt'); //actually a picture
