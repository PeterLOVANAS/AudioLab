export type UserRole = "admin" | "labeller" ; 


export type ProjectMember = {
    userId: string; 
    projectId: string; 
    displayName: string; 
    role: UserRole; 
}