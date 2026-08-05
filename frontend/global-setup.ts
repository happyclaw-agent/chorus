import fs from 'fs';
import path from 'path';

export default async () => {
    const statePath = path.resolve('./e2e/storageState.json');
    if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
    }

    fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
};
