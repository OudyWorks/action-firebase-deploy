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

import {
  endGroup,
  getInput,
  setFailed,
  setOutput,
  startGroup,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { existsSync } from "fs";
import { createCheck } from "./createCheck";
import { createGacFile } from "./createGACFile";
import {
  deployPreview,
  deployProductionSite,
  ErrorResult,
  interpretChannelDeployResult,
} from "./deploy";
import { getChannelId } from "./getChannelId";
import {
  getURLsMarkdownFromChannelDeployResult,
  postChannelSuccessComment,
} from "./postOrUpdateComment";

// Inputs defined in action.yml
const expires = getInput("expires");
const projectId = getInput("projectId");
const googleApplicationCredentials = getInput("firebaseServiceAccount", {
  required: true,
});
const configuredChannelId = getInput("channelId");
const isProductionDeploy = configuredChannelId === "live";
const token = process.env.GITHUB_TOKEN || getInput("repoToken");
const octokit = token ? getOctokit(token) : undefined;
const entryPoint = getInput("entryPoint");
const config = getInput("config") || "firebase.json";
// Multiline input for targets; split on newlines and commas, trim empties
const rawTargets = getInput("targets");
const targets = rawTargets
  ? rawTargets
      .split(/\n|,/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : undefined;
const firebaseToolsVersion = getInput("firebaseToolsVersion");
const disableComment = getInput("disableComment");

async function run() {
  const isPullRequest = !!context.payload.pull_request;

  let finish = (details: Object) => console.log(details);
  if (token && isPullRequest) {
    finish = await createCheck(octokit, context);
  }

  try {
    startGroup("Verifying firebase.json exists");

    if (entryPoint !== ".") {
      console.log(`Changing to directory: ${entryPoint}`);
      try {
        process.chdir(entryPoint);
      } catch (err) {
        throw Error(`Error changing to directory ${entryPoint}: ${err}`);
      }
    }

    if (existsSync(`./${config}`)) {
      console.log(`${config} file found. Continuing deploy.`);
    } else {
      throw Error(
        `${config} file not found. If your config file is not in the root of your repo, edit the entryPoint option or set the config option of this GitHub action.`
      );
    }
    endGroup();

    startGroup("Setting up CLI credentials");
    const gacFilename = await createGacFile(googleApplicationCredentials);
    console.log(
      "Created a temporary file with Application Default Credentials."
    );
    endGroup();

    if (isProductionDeploy) {
      startGroup("Deploying to production site");
      const deployment = await deployProductionSite(gacFilename, {
        projectId,
        targets,
        config,
        firebaseToolsVersion,
      });
      if (deployment.status === "error") {
        throw Error((deployment as ErrorResult).error);
      }
      endGroup();

      // Default to the project's Hosting hostname
      const hostname = `${projectId}.web.app`;
      const url = `https://${hostname}/`;
      // Build a human-readable summary of deployed resources from deployment.result
      const deployedResources: string[] = [];
      try {
        const result: Record<string, unknown> = (deployment as any).result || {};
        for (const key of Object.keys(result)) {
          const val = (result as any)[key];
          if (Array.isArray(val)) {
            deployedResources.push(`${key}: ${val.length} item(s)`);
          } else if (typeof val === "string") {
            deployedResources.push(`${key}: ${val}`);
          } else if (typeof val === "object" && val) {
            deployedResources.push(`${key}: updated`);
          } else {
            deployedResources.push(`${key}`);
          }
        }
      } catch (e) {
        // ignore formatting errors
      }

      const summaryLines = [
        `Deployed resources:`,
        ...(deployedResources.length > 0 ? deployedResources : ["hosting"]),
        `Primary URL: [${hostname}](${url})`,
      ];

      await finish({
        details_url: url,
        conclusion: "success",
        output: {
          title: `Production deploy succeeded`,
          summary: summaryLines.join("\n"),
        },
      });
      return;
    }

    const channelId = getChannelId(configuredChannelId, context);

    startGroup(`Deploying to Firebase preview channel ${channelId}`);
    const deployment = await deployPreview(gacFilename, {
      projectId,
      expires,
      channelId,
      targets,
      config,
      firebaseToolsVersion,
    });

    if (deployment.status === "error") {
      throw Error((deployment as ErrorResult).error);
    }
    endGroup();

    const { expireTime, expire_time_formatted, urls } =
      interpretChannelDeployResult(deployment);

    setOutput("urls", urls);
    setOutput("expire_time", expireTime);
    setOutput("expire_time_formatted", expire_time_formatted);
    setOutput("details_url", urls[0]);

    if (disableComment === "true") {
      console.log(
        `Commenting on PR is disabled with "disableComment: ${disableComment}"`
      );
    } else if (token && isPullRequest && !!octokit) {
      const commitId = context.payload.pull_request?.head.sha.substring(0, 7);

      await postChannelSuccessComment(octokit, context, deployment, commitId);
    }

    await finish({
      details_url: urls[0],
      conclusion: "success",
      output: {
        title: `Deploy preview succeeded`,
        summary: getURLsMarkdownFromChannelDeployResult(deployment),
      },
    });
  } catch (e) {
    setFailed(e.message);

    await finish({
      conclusion: "failure",
      output: {
        title: "Deploy preview failed",
        summary: `Error: ${e.message}`,
      },
    });
  }
}

run();
