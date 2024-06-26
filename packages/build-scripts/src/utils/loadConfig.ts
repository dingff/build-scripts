import path from 'path';
import fs from 'fs';
import fg from 'fast-glob';
import JSON5 from 'json5';
import { createRequire } from 'module';
import buildConfig from './buildConfig.js';
import dynamicImport from './dynamicImport.js';

import type { UserConfig, ModeConfig, CommandArgs, EmptyObject, PluginList, Json } from '../types.js';
import type { CreateLoggerReturns } from './logger.js';

const require = createRequire(import.meta.url);

export const mergeModeConfig = <K> (mode: string, userConfig: UserConfig<K>): UserConfig<K> => {
  // modify userConfig by userConfig.modeConfig
  if (
    userConfig.modeConfig &&
    mode &&
    (userConfig.modeConfig as ModeConfig<K>)[mode]
  ) {
    const {
      plugins,
      ...basicConfig
    } = (userConfig.modeConfig as ModeConfig<K>)[mode] as UserConfig<K>;
    const userPlugins = [...userConfig.plugins];
    if (Array.isArray(plugins)) {
      const pluginKeys = userPlugins.map((pluginInfo) => {
        return Array.isArray(pluginInfo) ? pluginInfo[0] : pluginInfo;
      });
      plugins.forEach((pluginInfo) => {
        const [pluginName] = Array.isArray(pluginInfo)
          ? pluginInfo
          : [pluginInfo];
        const pluginIndex = pluginKeys.indexOf(pluginName);
        if (pluginIndex > -1) {
          // overwrite plugin info by modeConfig
          userPlugins[pluginIndex] = pluginInfo;
        } else {
          // push new plugin added by modeConfig
          userPlugins.push(pluginInfo);
        }
      });
    }
    return { ...userConfig, ...basicConfig, plugins: userPlugins };
  }
  return userConfig;
};

export const resolveConfigFile = async (configFile: string | string[], commandArgs: CommandArgs, rootDir: string) => {
  const { config } = commandArgs;
  let configPath = '';
  if (config) {
    configPath = path.isAbsolute(config)
      ? config
      : path.resolve(rootDir, config);
  } else {
    const [defaultUserConfig] = await fg(configFile, { cwd: rootDir, absolute: true });
    configPath = defaultUserConfig;
  }
  return configPath;
}

export const getUserConfig = async <K extends EmptyObject>({
  rootDir,
  commandArgs,
  logger,
  pkg,
  configFilePath,
}: {
  rootDir: string;
  commandArgs: CommandArgs;
  pkg: Json;
  logger: CreateLoggerReturns;
  configFilePath: string;
}): Promise<UserConfig<K>> => {
  let userConfig = {
    plugins: [] as PluginList,
  };
  if (configFilePath && fs.existsSync(configFilePath)) {
    try {
      userConfig = await loadConfig(configFilePath, pkg, logger);
    } catch (err) {
      logger.warn(`Fail to load config file ${configFilePath}`);

      if (err instanceof Error) {
        logger.error(err.stack);
      } else {
        logger.error(err.toString());
      }

      process.exit(1);
    }
  } else if (configFilePath) {
    // If path was not found
    logger.error(`config file${`(${configFilePath})` || ''} is not exist`);
    process.exit(1);
  } else {
    logger.debug(
      'It\'s most likely you don\'t have a config file in root directory!\n' +
      'Just ignore this message if you know what you do; Otherwise, check it by yourself.',
    );
  }

  return mergeModeConfig(commandArgs.mode, userConfig as UserConfig<K>);
};

export async function loadConfig<T>(filePath: string, pkg: Json, logger: CreateLoggerReturns): Promise<T|undefined> {
  const start = Date.now();
  const isTypeModule = pkg?.type === 'module';
  const isJson = filePath.endsWith('.json');

  // The extname of files may `.mts|.ts`
  const isTs = filePath.endsWith('ts');
  const isJs = filePath.endsWith('js');

  const isESM = ['mjs', 'mts'].some((type) => filePath.endsWith(type))
    || (isTypeModule && ['js', 'ts'].some((type) => filePath.endsWith(type)));

  let userConfig: T | undefined;

  if (isJson) {
    return JSON5.parse(fs.readFileSync(filePath, 'utf8'));
  }

  // If config file respect ES module spec.
  if (isESM && isJs) {
    userConfig = (await dynamicImport(filePath, true))?.default;
  }

  // Config file respect CommonJS spec.
  if (!isESM && isJs) {
    userConfig = require(filePath);
  }

  if (isTs) {
    const code = await buildConfig(filePath, isESM ? 'esm' : 'cjs');
    userConfig = await executeTypescriptModule(code, filePath, isESM);
    logger.debug(`bundled module file loaded in ${Date.now() - start}m`);
  }


  return userConfig;
}

async function executeTypescriptModule(code: string, filePath: string, isEsm = true) {
  const tempFile = `${filePath}.${isEsm ? 'm' : 'c'}js`;
  let userConfig = null;

  fs.writeFileSync(tempFile, code);

  delete require.cache[require.resolve(tempFile)];

  try {
    const raw = isEsm ? (await dynamicImport(tempFile, true)) : require(tempFile);
    userConfig = raw?.default ?? raw;
  } catch (err) {
    fs.unlinkSync(tempFile);

    // Hijack error message
    if (err instanceof Error) {
      err.message = err.message.replace(tempFile, filePath);
      err.stack = err.stack.replace(tempFile, filePath);
    }

    throw err;
  }

  fs.unlinkSync(tempFile);

  return userConfig;
}
