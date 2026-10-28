import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';

export class JsonFile {
  directory = 'results';

  async save(data: unknown, prefix = '') {
    console.log('[JsonFile.save] Inicio');
    console.log('Prefijo:', prefix);

    let content = typeof data === 'string'
      ? data
      : inspect(data, { depth: null, maxArrayLength: null, maxStringLength: null });
    let extension = 'txt';

    try {
      const value = typeof data === 'string' ? JSON.parse(data) : data;
      const json = JSON.stringify(value, null, 2);
      if (json !== undefined) {
        content = json;
        extension = 'json';
      }
    } catch {
      console.log('El dato no se puede convertir a JSON; se guardará como texto.');
    }

    console.log('Formato:', extension === 'json' ? 'JSON' : 'texto plano');
    console.log('Contenido:', content);

    const date = new Date().toISOString().replace(/[:.]/g, '-');
    const name = (prefix ? prefix + '-' : '') + date + '.' + extension;
    const filePath = join(this.directory, name);
    console.log('Archivo:', filePath);

    await mkdir(this.directory, { recursive: true });
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });

    console.log('[JsonFile.save] Guardado:', filePath);
    return filePath;
  }
}
