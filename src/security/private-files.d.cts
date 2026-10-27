/** Optional environment map supplies SYNCARE_PRIVATE_KEY_FILE for the Linux AES-GCM adapter. */
export type PrivateEnvironment = Record<string, string | undefined>;

export function protectText(text: string, environment?: PrivateEnvironment): string;
export function unprotectText(text: string, environment?: PrivateEnvironment): string;
export function readPrivateJson(file: string | URL, environment?: PrivateEnvironment): any;
export function writePrivateJson(file: string | URL, value: unknown, environment?: PrivateEnvironment): void;
export function unprotectEnvironment(environment?: PrivateEnvironment): PrivateEnvironment;
