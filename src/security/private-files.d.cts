export function protectText(text:string):string;
export function unprotectText(text:string):string;
export function readPrivateJson(file:string|URL):any;
export function writePrivateJson(file:string|URL,value:unknown):void;
export function unprotectEnvironment(environment?:Record<string,string|undefined>):Record<string,string|undefined>;
