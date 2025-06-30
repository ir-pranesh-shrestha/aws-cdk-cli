import * as path from 'path';
import { integTest, withTemporaryDirectory, ShellHelper, withPackages } from '../../lib';

['app', 'sample-app'].forEach(template => {
  integTest(`init python ${template}`, withTemporaryDirectory(withPackages(async (context) => {
    context.library.assertJsiiPackagesAvailable();

    const shell = ShellHelper.fromContext(context);
    await context.cli.makeCliAvailable();

    await shell.shell(['cdk', 'init', '--lib-version', context.library.requestedVersion(), '-l', 'python', template]);
    const venvPath = path.resolve(context.integTestDir, '.venv');
    const venv = { PATH: `${venvPath}/bin:${process.env.PATH}`, VIRTUAL_ENV: venvPath };

    await shell.shell([`${venvPath}/bin/pip`, 'install', '-r', 'requirements.txt'], { modEnv: venv });
    await shell.shell([`${venvPath}/bin/pip`, 'install', '-r', 'requirements-dev.txt'], { modEnv: venv });
    await shell.shell([`${venvPath}/bin/pytest`], { modEnv: venv });
    await shell.shell(['cdk', 'synth'], { modEnv: venv });
  })));
});
