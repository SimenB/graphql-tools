import createUploadLink from 'apollo-upload-client/createUploadLink.mjs';
import formDataAppendFile from 'apollo-upload-client/formDataAppendFile.mjs';
import isExtractableFile from 'apollo-upload-client/isExtractableFile.mjs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import * as apolloImport from '@apollo/client';
import { AwaitVariablesLink } from './AwaitVariablesLink.js';

const apollo: typeof apolloImport = (apolloImport as any)?.default ?? apolloImport;

export const createServerHttpLink = (options: any) =>
  apollo.concat(
    new AwaitVariablesLink(),
    createUploadLink({
      ...options,
      fetch,
      FormData,
      isExtractableFile: (value: any) => isExtractableFile(value) || value?.createReadStream,
      formDataAppendFile: (form: FormData, index: string, file: any) => {
        if (file.createReadStream != null) {
          form.append(index, file.createReadStream(), {
            filename: file.filename,
            contentType: file.mimetype,
          });
        } else {
          formDataAppendFile(form as any, index, file);
        }
      },
    }) as any,
  );
