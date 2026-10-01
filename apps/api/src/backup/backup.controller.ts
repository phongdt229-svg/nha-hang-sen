import { Controller, Get, Post, BadRequestException, UseGuards } from '@nestjs/common';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Allow } from '../auth/principal';

interface BackupInfo {
  filename: string;
  size: number;
  createdAt: Date;
  path: string;
}

@Controller('admin/backup')
export class BackupController {
  private backupDir = join(process.cwd(), 'backups');

  @Allow('ADMIN')
  @Get('list')
  listBackups(): BackupInfo[] {
    if (!existsSync(this.backupDir)) return [];

    return readdirSync(this.backupDir)
      .filter((f) => f.startsWith('backup_') && f.endsWith('.sql.gz'))
      .map((filename) => {
        const path = join(this.backupDir, filename);
        const stat = statSync(path);
        return {
          filename,
          size: stat.size,
          createdAt: stat.birthtime,
          path: filename,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  @Allow('ADMIN')
  @Post('create')
  async createBackup() {
    try {
      // Create backups dir if not exists
      if (!existsSync(this.backupDir)) {
        execSync(`mkdir -p ${this.backupDir}`);
      }

      // Run backup script
      const cmd = `cd ${process.cwd()} && bash ./infra/backup.sh`;
      const output = execSync(cmd, { encoding: 'utf-8' });

      // Extract filename from output
      const match = output.match(/backups\/backup_[\d_]+\.sql\.gz/);
      const filename = match ? match[0].split('/')[1] : 'backup.sql.gz';

      return { success: true, filename, message: 'Backup created successfully' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Backup failed: ${message}`);
    }
  }

  @Allow('ADMIN')
  @Get('latest')
  getLatestBackup(): BackupInfo | null {
    const backups = this.listBackups();
    return backups.length > 0 ? backups[0] : null;
  }
}
