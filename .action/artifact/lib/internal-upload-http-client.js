"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("../../core");
const fs = __importStar(require("fs"));
const url_1 = require("url");
const internal_utils_1 = require("./internal-utils");
const internal_config_variables_1 = require("./internal-config-variables");
/**
 * Creates a file container for the new artifact in the remote blob storage/file service
 * @param {string} artifactName Name of the artifact being created
 * @returns The response from the Artifact Service if the file container was successfully created
 */
function createArtifactInFileContainer(artifactName) {
    return __awaiter(this, void 0, void 0, function* () {
        const parameters = {
            Type: 'actions_storage',
            Name: artifactName
        };
        const data = JSON.stringify(parameters, null, 2);
        const artifactUrl = internal_utils_1.getArtifactUrl();
        const client = internal_utils_1.createHttpClient();
        const requestOptions = internal_utils_1.getRequestOptions('application/json');
        const rawResponse = yield client.post(artifactUrl, data, requestOptions);
        const body = yield rawResponse.readBody();
        if (internal_utils_1.isSuccessStatusCode(rawResponse.message.statusCode) && body) {
            return JSON.parse(body);
        }
        else {
            // eslint-disable-next-line no-console
            console.log(rawResponse);
            throw new Error(`Unable to create a container for the artifact ${artifactName}`);
        }
    });
}
exports.createArtifactInFileContainer = createArtifactInFileContainer;
/**
 * Concurrently upload all of the files in chunks
 * @param {string} uploadUrl Base Url for the artifact that was created
 * @param {SearchResult[]} filesToUpload A list of information about the files being uploaded
 * @returns The size of all the files uploaded in bytes
 */
function uploadArtifactToFileContainer(uploadUrl, filesToUpload, options) {
    return __awaiter(this, void 0, void 0, function* () {
        const client = internal_utils_1.createHttpClient();
        const FILE_CONCURRENCY = internal_config_variables_1.getUploadFileConcurrency();
        const CHUNK_CONCURRENCY = internal_config_variables_1.getUploadChunkConcurrency();
        const MAX_CHUNK_SIZE = internal_config_variables_1.getUploadChunkSize();
        core_1.debug(`File Concurrency: ${FILE_CONCURRENCY}, Chunk Concurrency: ${CHUNK_CONCURRENCY} and Chunk Size: ${MAX_CHUNK_SIZE}`);
        const parameters = [];
        // by default, file uploads will continue if there is an error unless specified differently in the options
        let continueOnError = true;
        if (options) {
            if (options.continueOnError === false) {
                continueOnError = false;
            }
        }
        // Prepare the necessary parameters to upload all the files
        for (const file of filesToUpload) {
            const resourceUrl = new url_1.URL(uploadUrl);
            resourceUrl.searchParams.append('itemPath', file.uploadFilePath);
            parameters.push({
                file: file.absoluteFilePath,
                resourceUrl: resourceUrl.toString(),
                restClient: client,
                concurrency: CHUNK_CONCURRENCY,
                maxChunkSize: MAX_CHUNK_SIZE,
                continueOnError
            });
        }
        const parallelUploads = [...new Array(FILE_CONCURRENCY).keys()];
        const failedItemsToReport = [];
        let uploadedFiles = 0;
        let fileSizes = 0;
        let abortPendingFileUploads = false;
        // Only allow a certain amount of files to be uploaded at once, this is done to reduce potential errors
        yield Promise.all(parallelUploads.map(() => __awaiter(this, void 0, void 0, function* () {
            while (uploadedFiles < filesToUpload.length) {
                const currentFileParameters = parameters[uploadedFiles];
                uploadedFiles += 1;
                if (abortPendingFileUploads) {
                    failedItemsToReport.push(currentFileParameters.file);
                    continue;
                }
                const uploadFileResult = yield uploadFileAsync(currentFileParameters);
                fileSizes += uploadFileResult.successfulUploadSize;
                if (uploadFileResult.isSuccess === false) {
                    failedItemsToReport.push(currentFileParameters.file);
                    if (!continueOnError) {
                        // Existing uploads will be able to finish however all pending uploads will fail fast
                        abortPendingFileUploads = true;
                    }
                }
            }
        })));
        core_1.info(`Total size of all the files uploaded is ${fileSizes} bytes`);
        return {
            size: fileSizes,
            failedItems: failedItemsToReport
        };
    });
}
exports.uploadArtifactToFileContainer = uploadArtifactToFileContainer;
/**
 * Asynchronously uploads a file. If the file is bigger than the max chunk size it will be uploaded via multiple calls
 * @param {UploadFileParameters} parameters Information about the file that needs to be uploaded
 * @returns The size of the file that was uploaded in bytes along with any failed uploads
 */
function uploadFileAsync(parameters) {
    return __awaiter(this, void 0, void 0, function* () {
        const fileSize = fs.statSync(parameters.file).size;
        const parallelUploads = [...new Array(parameters.concurrency).keys()];
        let offset = 0;
        let isUploadSuccessful = true;
        let failedChunkSizes = 0;
        let abortFileUpload = false;
        yield Promise.all(parallelUploads.map(() => __awaiter(this, void 0, void 0, function* () {
            while (offset < fileSize) {
                const chunkSize = Math.min(fileSize - offset, parameters.maxChunkSize);
                if (abortFileUpload) {
                    // if we don't want to continue on error, any pending upload chunk will be marked as failed
                    failedChunkSizes += chunkSize;
                    continue;
                }
                const start = offset;
                const end = offset + chunkSize - 1;
                offset += parameters.maxChunkSize;
                const chunk = fs.createReadStream(parameters.file, {
                    start,
                    end,
                    autoClose: false
                });
                const result = yield uploadChunk(parameters.restClient, parameters.resourceUrl, chunk, start, end, fileSize);
                if (!result) {
                    /**
                     * Chunk failed to upload, report as failed and do not continue uploading any more chunks for the file. It is possible that part of a chunk was
                     * successfully uploaded so the server may report a different size for what was uploaded
                     **/
                    isUploadSuccessful = false;
                    failedChunkSizes += chunkSize;
                    core_1.warning(`Aborting upload for ${parameters.file} due to failure`);
                    abortFileUpload = true;
                }
            }
        })));
        return {
            isSuccess: isUploadSuccessful,
            successfulUploadSize: fileSize - failedChunkSizes
        };
    });
}
/**
 * Uploads a chunk of an individual file to the specified resourceUrl. If the upload fails and the status code
 * indicates a retryable status, we try to upload the chunk as well
 * @param {HttpClient} restClient RestClient that will be making the appropriate HTTP call
 * @param {string} resourceUrl Url of the resource that the chunk will be uploaded to
 * @param {NodeJS.ReadableStream} data Stream of the file that will be uploaded
 * @param {number} start Starting byte index of file that the chunk belongs to
 * @param {number} end Ending byte index of file that the chunk belongs to
 * @param {number} totalSize Total size of the file in bytes that is being uploaded
 * @returns if the chunk was successfully uploaded
 */
function uploadChunk(restClient, resourceUrl, data, start, end, totalSize) {
    return __awaiter(this, void 0, void 0, function* () {
        core_1.info(`Uploading chunk of size ${end -
            start +
            1} bytes at offset ${start} with content range: ${internal_utils_1.getContentRange(start, end, totalSize)}`);
        const requestOptions = internal_utils_1.getRequestOptions('application/octet-stream', totalSize, internal_utils_1.getContentRange(start, end, totalSize));
        const uploadChunkRequest = () => __awaiter(this, void 0, void 0, function* () {
            return yield restClient.sendStream('PUT', resourceUrl, data, requestOptions);
        });
        const response = yield uploadChunkRequest();
        if (internal_utils_1.isSuccessStatusCode(response.message.statusCode)) {
            core_1.debug(`Chunk for ${start}:${end} was successfully uploaded to ${resourceUrl}`);
            return true;
        }
        else if (internal_utils_1.isRetryableStatusCode(response.message.statusCode)) {
            core_1.info(`Received http ${response.message.statusCode} during chunk upload, will retry at offset ${start} after 10 seconds.`);
            yield new Promise(resolve => setTimeout(resolve, 10000));
            const retryResponse = yield uploadChunkRequest();
            if (internal_utils_1.isSuccessStatusCode(retryResponse.message.statusCode)) {
                return true;
            }
            else {
                core_1.info(`Unable to upload chunk even after retrying`);
                // eslint-disable-next-line no-console
                console.log(response);
                return false;
            }
        }
        // Upload must have failed spectacularly somehow, log full result for diagnostic purposes
        // eslint-disable-next-line no-console
        console.log(response);
        return false;
    });
}
/**
 * Updates the size of the artifact from -1 which was initially set when the container was first created for the artifact.
 * Updating the size indicates that we are done uploading all the contents of the artifact. A server side check will be run
 * to check that the artifact size is correct for billing purposes
 */
function patchArtifactSize(size, artifactName) {
    return __awaiter(this, void 0, void 0, function* () {
        const client = internal_utils_1.createHttpClient();
        const requestOptions = internal_utils_1.getRequestOptions('application/json');
        const resourceUrl = new url_1.URL(internal_utils_1.getArtifactUrl());
        resourceUrl.searchParams.append('artifactName', artifactName);
        const parameters = { Size: size };
        const data = JSON.stringify(parameters, null, 2);
        core_1.debug(`URL is ${resourceUrl.toString()}`);
        const rawResponse = yield client.patch(resourceUrl.toString(), data, requestOptions);
        const body = yield rawResponse.readBody();
        if (internal_utils_1.isSuccessStatusCode(rawResponse.message.statusCode)) {
            core_1.debug(`Artifact ${artifactName} has been successfully uploaded, total size ${size}`);
            core_1.debug(body);
        }
        else if (rawResponse.message.statusCode === 404) {
            throw new Error(`An Artifact with the name ${artifactName} was not found`);
        }
        else {
            // eslint-disable-next-line no-console
            console.log(body);
            throw new Error(`Unable to finish uploading artifact ${artifactName}`);
        }
    });
}
exports.patchArtifactSize = patchArtifactSize;
//# sourceMappingURL=internal-upload-http-client.js.map