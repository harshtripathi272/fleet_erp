import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { NotFoundError } from '../../core/errors/index.js';
import { setSenderName } from '../../core/mail/mailer.js';
import { fileStore } from '../../core/storage/index.js';
import { StoredFile } from '../files/file.model.js';
import { Company } from './company.model.js';

/**
 * The company's brand (#71): what the product is called and how it looks to everyone who uses it, staff, drivers
 * and customers alike. Read before sign-in (the sign-in page shows it), so only what is safe to show anyone is
 * returned, and only the files the brand names are ever served without a session.
 */

/** Used where a company has not named its product yet: neutral, never another company's name. */
export const DEFAULT_PRODUCT_NAME = 'Fleet';

export type BrandAsset = 'logo' | 'logo-dark' | 'icon' | 'logo-pdf';
const FIELD: Record<BrandAsset, string> = { logo: 'logoFileId', 'logo-dark': 'logoDarkFileId', icon: 'iconFileId', 'logo-pdf': 'logoPdfFileId' };

interface BrandDoc { productName?: string; shortName?: string; logoFileId?: unknown; logoDarkFileId?: unknown; iconFileId?: unknown; logoPdfFileId?: unknown; accent?: string; emailSenderName?: string; signature?: string }
interface WatermarkDoc { mode?: 'off' | 'text' | 'logo'; text?: string; opacity?: number; angle?: number; tripSheet?: boolean; statement?: boolean; invoice?: boolean; screens?: boolean }

async function companyBrand() {
  const company = await Company.findOne().select('legalName tradingName brand watermark').lean<{ legalName?: string; tradingName?: string; brand?: BrandDoc; watermark?: WatermarkDoc }>();
  return { company, brand: company?.brand ?? {}, watermark: company?.watermark ?? {} };
}

/** The product's name: the company's choice, else its trading or legal name, else a neutral default. */
export async function productName(): Promise<string> {
  const { company, brand } = await companyBrand();
  return brand.productName || company?.tradingName || company?.legalName || DEFAULT_PRODUCT_NAME;
}

/** Everything the screens need to look like the company's product, safe to show before sign-in. */
export async function publicBrand() {
  const { company, brand, watermark } = await companyBrand();
  const name = brand.productName || company?.tradingName || company?.legalName || DEFAULT_PRODUCT_NAME;
  const url = (asset: BrandAsset) => (brand[FIELD[asset] as keyof BrandDoc] ? `/api/v1/brand/${asset}?v=${String(brand[FIELD[asset] as keyof BrandDoc])}` : null);
  return {
    productName: name,
    shortName: brand.shortName || name,
    companyName: company?.tradingName || company?.legalName || null,
    logo: url('logo'),
    logoDark: url('logo-dark'),
    icon: url('icon'),
    accent: brand.accent ?? null,
    watermark: { mode: watermark.mode ?? 'off', text: watermark.text ?? null, opacity: watermark.opacity ?? 0.08, angle: watermark.angle ?? 35, screens: Boolean(watermark.screens) },
    /** An installation with simulators on is a test copy: every document and screen says so. */
    testMark: env.DRIVER_PHONE_SIMULATOR,
  };
}

/** The brand for documents: the watermark to draw on one kind of document, and the PDF logo's bytes. */
export async function documentBrand(kind: 'tripSheet' | 'statement' | 'invoice') {
  const { brand, watermark } = await companyBrand();
  const logo = brand.logoPdfFileId ? await readFile(String(brand.logoPdfFileId)).catch(() => null) : null;
  const mark = watermark.mode && watermark.mode !== 'off' && watermark[kind] !== false
    ? { text: watermark.mode === 'text' ? (watermark.text || null) : null, logo: watermark.mode === 'logo', opacity: watermark.opacity ?? 0.08, angle: watermark.angle ?? 35 }
    : null;
  return { logo, watermark: mark, testMark: env.DRIVER_PHONE_SIMULATOR };
}

async function readFile(id: string): Promise<Buffer> {
  const file = await StoredFile.findById(id).select('key').lean<{ key: string }>();
  if (!file) throw new NotFoundError('File not found');
  const stream = await (await fileStore()).open(file.key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** One of the brand's files, served without a session. Any other file id is refused. */
export async function brandAsset(asset: BrandAsset): Promise<{ mime: string; stream: Readable }> {
  const { brand } = await companyBrand();
  const id = brand[FIELD[asset] as keyof BrandDoc];
  if (!id) throw new NotFoundError('No such brand file');
  const file = await StoredFile.findById(id).select('key mime').lean<{ key: string; mime: string }>();
  if (!file || !file.mime.startsWith('image/')) throw new NotFoundError('No such brand file');
  return { mime: file.mime, stream: await (await fileStore()).open(file.key) };
}

// Every e-mail comes from the company's own name: its chosen sender name, else the product's name.
setSenderName(async () => {
  const { brand } = await companyBrand();
  return brand.emailSenderName || (await productName());
});
