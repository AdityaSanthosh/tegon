/** Copyright (c) 2024, Tegon, all rights reserved. **/

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import { IssueWithRelations } from 'modules/issues/issues.interface';

import { issueSchema } from './vector.interface';

@Injectable()
export class VectorService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private typesenseClient: TypesenseClient,
  ) {}

  private readonly logger: Logger = new Logger('VectorService');

  async onModuleInit() {
    // await this.typesenseClient.collections('issues').delete();
    await this.createIssuesCollection();
  }

  async createIssuesCollection() {
    try {
      await this.typesenseClient.collections('issues').retrieve();
      this.logger.log('Issues collection already exists');
    } catch (error) {
      if (error.httpStatus === 404) {
        await this.typesenseClient.collections().create(issueSchema);
        this.logger.log('Created an issue collection');
        const workspaces = await this.prisma.workspace.findMany({
          where: { deleted: null },
          select: { id: true },
        });
        await Promise.all(
          workspaces.map((workspace) => this.prefillIssuesData(workspace.id)),
        );
        this.logger.log('Prefilled data for all workspaces');
      } else {
        this.logger.error('Error creating issues collection:', error);
      }
    }
  }

  async createIssueEmbedding(issue: IssueWithRelations) {
    const issueNumber = `${issue.team.identifier}-${issue.number}`;

    await this.typesenseClient
      .collections('issues')
      .documents()
      .upsert({
        id: issue.id,
        teamId: issue.teamId,
        number: issue.number,
        numberString: issue.number.toString(),
        issueNumber,
        title: issue.title,
        description: issue.description ?? '',
        stateId: issue.stateId,
        workspaceId: issue.team.workspaceId,
      });
  }

  async searchEmbeddings(
    workspaceId: string,
    searchQuery: string,
    limit: number,
  ) {
    const searchParameters = {
      q: searchQuery || '*',
      query_by: 'numberString,issueNumber,title,description,embedding',
      filter_by: `workspaceId:=${workspaceId}`,
      sort_by: searchQuery ? '_text_match:desc' : 'number:desc',
      vector_query: 'embedding:([], distance_threshold:0.80)',
      page: 1,
      per_page: limit,
    };

    const searchResults = await this.typesenseClient
      .collections('issues')
      .documents()
      .search(searchParameters);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return searchResults.hits.map((hit: any) => ({
      id: hit.document.id,
      title: hit.document.title,
      description: hit.document.description,
      stateId: hit.document.stateId,
      teamId: hit.document.teamId,
      number: hit.document.number,
      issueNumber: hit.document.issueNumber,
      score: hit.hybrid_search_info?.rank_fusion_score || 0,
    }));
  }

  async prefillIssuesData(workspaceId: string) {
    const issues = await this.prisma.issue.findMany({
      where: { team: { workspaceId }, deleted: null },
      include: { team: true },
    });

    for (const issue of issues) {
      await this.createIssueEmbedding(issue);
    }

    this.logger.log(
      `Prefilled all issues data into vector for workspaceId: ${workspaceId}`,
    );
  }
}
