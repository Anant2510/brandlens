import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'brandlens:isPublic';

/** Opts a route out of authentication. Used sparingly and audited on review. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
