export type ExpectedResume = {filename:string;sha256?:string};
export function resumeOnPage(expected?:ExpectedResume): Promise<{status:string;files:{filename:string;sha256?:string;source:string}[];reason?:string}>;
