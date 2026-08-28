import { config as loadEnvFile } from 'dotenv';

loadEnvFile({ path: '.env.local' });
loadEnvFile();
