import { IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { CAPABILITIES, type Capability, type Role, type SetAclRequest } from '@oc/shared';

export class SetAclDto implements SetAclRequest {
  @IsUUID()
  userId!: string;

  // Provide a preset role…
  @IsOptional()
  @IsIn(['owner', 'editor', 'viewer'])
  role?: Role;

  // …or explicit fine-grained capabilities.
  @IsOptional()
  @IsArray()
  @IsIn([...CAPABILITIES], { each: true })
  capabilities?: Capability[];
}
