/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { exec } from "@actions/exec";

export type SiteDeploy = {
  site: string;
  target?: string;
  url: string;
  expireTime: string;
};

export type ErrorResult = {
  status: "error";
  error: string;
};

export type ChannelSuccessResult = {
  status: "success";
  result: { [key: string]: SiteDeploy };
};

export type ProductionSuccessResult = {
  status: "success";
  // Result contains resource-specific outputs from firebase-tools. Keys vary by resource.
  result: Record<string, unknown>;
};

type DeployConfig = {
  projectId: string;
  // Optional list of Firebase targets to pass via --only
  targets?: string[];
  // Optional firebase config file path (relative to entry point)
  config?: string;
  // Optional version specification for firebase-tools. Defaults to `latest`.
  firebaseToolsVersion?: string;
};

export type ChannelDeployConfig = DeployConfig & {
  expires: string;
  channelId: string;
};

export type ProductionDeployConfig = DeployConfig & {};

export function interpretChannelDeployResult(
  deployResult: ChannelSuccessResult
): { expireTime: string; expire_time_formatted: string; urls: string[] } {
  const allSiteResults = Object.values(deployResult.result);

  const expireTime = allSiteResults[0].expireTime;
  const expire_time_formatted = new Date(expireTime).toUTCString();
  const urls = allSiteResults.map((siteResult) => siteResult.url);

  return {
    expireTime,
    expire_time_formatted,
    urls,
  };
}

type AuthOptions = { gacFilename?: string; firebaseToken?: string };

async function execWithCredentials(
  args: string[],
  projectId,
  auth: AuthOptions,
  opts: { debug?: boolean; firebaseToolsVersion?: string }
) {
  let deployOutputBuf: Buffer[] = [];
  const debug = opts.debug || false;
  const firebaseToolsVersion = opts.firebaseToolsVersion || "latest";

  try {
    await exec(
      `npx firebase-tools@${firebaseToolsVersion}`,
      [
        ...args,
        ...(projectId ? ["--project", projectId] : []),
        ...(auth.firebaseToken ? ["--token", auth.firebaseToken] : []),
        debug
          ? "--debug" // gives a more thorough error message
          : "", // allows us to easily parse the output
      ],
      {
        listeners: {
          stdout(data: Buffer) {
            deployOutputBuf.push(data);
          },
        },
        env: {
          ...process.env,
          FIREBASE_DEPLOY_AGENT: "oudyworks-action-firebase-deploy",
          ...(auth.gacFilename
            ? { GOOGLE_APPLICATION_CREDENTIALS: auth.gacFilename }
            : {}), // the CLI will automatically authenticate with this env variable set
        },
      }
    );
  } catch (e) {
    console.log(Buffer.concat(deployOutputBuf).toString("utf-8"));
    console.log(e.message);

    if (!debug) {
      console.log(
        "Retrying deploy with the --debug flag for better error output"
      );
      await execWithCredentials(args, projectId, auth, {
        debug: true,
        firebaseToolsVersion,
      });
    } else {
      throw e;
    }
  }

  return deployOutputBuf.length
    ? deployOutputBuf[deployOutputBuf.length - 1].toString("utf-8")
    : ""; // output from the CLI
}

export async function deployPreview(
  auth: AuthOptions,
  deployConfig: ChannelDeployConfig
) {
  const { projectId, channelId, targets, expires, firebaseToolsVersion, config } =
    deployConfig;

  const deploymentText = await execWithCredentials(
    [
      "hosting:channel:deploy",
      channelId,
      ...(config ? ["--config", config] : []),
      ...(targets && targets.length > 0 ? ["--only", targets.join(",")] : []),
      ...(expires ? ["--expires", expires] : []),
    ],
    projectId,
    auth,
    { firebaseToolsVersion }
  );

  const deploymentResult = JSON.parse(deploymentText.trim()) as
    | ChannelSuccessResult
    | ErrorResult;

  return deploymentResult;
}

export async function deployProductionSite(
  auth: AuthOptions,
  productionDeployConfig: ProductionDeployConfig
) {
  const { projectId, targets, firebaseToolsVersion, config } = productionDeployConfig;

  const deploymentText = await execWithCredentials(
    [
      "deploy",
      ...(config ? ["--config", config] : []),
      ...(targets && targets.length > 0 ? ["--only", targets.join(",")] : []),
    ],
    projectId,
    auth,
    { firebaseToolsVersion }
  );

  const deploymentResult = JSON.parse(deploymentText) as
    | ProductionSuccessResult
    | ErrorResult;

  return deploymentResult;
}
